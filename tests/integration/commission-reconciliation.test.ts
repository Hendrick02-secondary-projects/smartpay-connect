import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import ExcelJS from "exceljs";
import { closeDb, getDb } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { createAdjustment, createRuleVersion, issueInvoice, recordCollection } from "@/lib/commission/service";
import { authorizeSimulatedPayment, createPaymentIntent, reverseSimulatedPayment } from "@/lib/payments/service";
import { parseSettlementFile } from "@/lib/reconciliation/parser-xlsx";
import { fileHash, importSettlement, resolveException } from "@/lib/reconciliation/service";
import { transactionsWorkbook } from "@/lib/reports/excel";
import { createPaymentSchema } from "@/lib/validation/payment";
import { createOwner, createTenant, hasDb, paymentInput, provider, truncateAll, type Tenant } from "./helpers";

async function paidPayment(t: Tenant, amount = "10000") {
  const p = provider();
  const input = createPaymentSchema.parse({ ...paymentInput(t), debitNotes: [{ number: `DN-${Math.floor(Math.random() * 1e6)}`, amount }] });
  const r = await createPaymentIntent(getDb(), p, t.slug, input, { ipHash: `ip-${Math.random()}` });
  await authorizeSimulatedPayment(getDb(), p, t.slug, r.reference, r.clientSecret!, "approve");
  const [intent] = await getDb().select().from(s.paymentIntents).where(eq(s.paymentIntents.reference, r.reference));
  return intent!;
}

const csv = (rows: string[][]) =>
  Buffer.from(["settlement_reference,payment_reference,bank_account,movement_type,gross_amount,status,value_date", ...rows.map((r) => r.join(","))].join("\n"));

describe.skipIf(!hasDb)("commission engine (integration)", () => {
  let t: Tenant;
  beforeEach(async () => {
    await truncateAll();
    t = await createTenant("demo");
  });
  afterAll(() => closeDb());

  it("new rule versions never re-price existing commissions", async () => {
    const owner = await createOwner();
    const p1 = await paidPayment(t);
    await expect(
      createRuleVersion(getDb(), { organizationId: t.orgId, ratePpm: 10_000, effectiveFrom: new Date(Date.now() - 86_400_000), effectiveTo: null, contractReference: "X" }, { userId: owner.userId }),
    ).rejects.toThrow(/passado/);
    const v2 = await createRuleVersion(
      getDb(),
      { organizationId: t.orgId, ratePpm: 10_000, effectiveFrom: new Date(Date.now() + 1000), effectiveTo: null, contractReference: "CTR-2" },
      { userId: owner.userId },
    );
    expect(v2.version).toBe(2);
    await new Promise((r) => setTimeout(r, 1100));
    const p2 = await paidPayment(t);
    const entries = await getDb().select().from(s.commissionEntries);
    const e1 = entries.find((e) => e.paymentIntentId === p1.id)!;
    const e2 = entries.find((e) => e.paymentIntentId === p2.id)!;
    expect([e1.ruleVersion, e1.amountMinor]).toEqual([1, 5_000]);
    expect([e2.ruleVersion, e2.amountMinor]).toEqual([2, 10_000]);
  });

  it("reversal creates a compensating entry; the ledger rejects UPDATE/DELETE", async () => {
    const owner = await createOwner();
    const p = await paidPayment(t);
    const outcome = await reverseSimulatedPayment(getDb(), provider(), p.id, "Chargeback de teste simulado", owner.userId);
    expect(outcome).toMatchObject({ result: "processed", to: "reversed" });
    const entries = await getDb().select().from(s.commissionEntries).where(eq(s.commissionEntries.paymentIntentId, p.id));
    expect(entries.map((e) => [e.entryType, e.amountMinor]).sort()).toEqual([
      ["accrual", 5_000],
      ["reversal", -5_000],
    ]);
    await expect(getDb().update(s.commissionEntries).set({ amountMinor: 1 }).where(eq(s.commissionEntries.id, entries[0]!.id))).rejects.toThrow(/append-only/);
    await expect(getDb().delete(s.commissionEntries).where(eq(s.commissionEntries.id, entries[0]!.id))).rejects.toThrow(/append-only/);
  });

  it("accrual is not collection: invoice + explicit collection required, no overpayment", async () => {
    const owner = await createOwner();
    await paidPayment(t);
    await createAdjustment(getDb(), { organizationId: t.orgId, paymentIntentId: null, amountMinor: -1_000, reason: "Crédito de cortesia de teste" }, { userId: owner.userId });
    const today = new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);
    const inv = await issueInvoice(getDb(), { organizationId: t.orgId, periodStart: today, periodEnd: today }, { userId: owner.userId });
    expect(inv.amountMinor).toBe(4_000);
    expect(inv.status).toBe("issued");
    await expect(issueInvoice(getDb(), { organizationId: t.orgId, periodStart: today, periodEnd: today }, { userId: owner.userId })).rejects.toThrow(/por facturar/);
    const part = await recordCollection(getDb(), { invoiceId: inv.id, amountMinor: 1_500, receivedAt: new Date(), collectionReference: "TRF-1", method: "bank_transfer" }, { userId: owner.userId });
    expect(part.status).toBe("partially_paid");
    await expect(
      recordCollection(getDb(), { invoiceId: inv.id, amountMinor: 9_999, receivedAt: new Date(), collectionReference: "TRF-2", method: "bank_transfer" }, { userId: owner.userId }),
    ).rejects.toThrow(/excede/);
    const full = await recordCollection(getDb(), { invoiceId: inv.id, amountMinor: 2_500, receivedAt: new Date(), collectionReference: "TRF-3", method: "bank_transfer" }, { userId: owner.userId });
    expect(full.status).toBe("paid");
  });
});

describe.skipIf(!hasDb)("reconciliation (integration)", () => {
  let t: Tenant;
  beforeEach(async () => {
    await truncateAll();
    t = await createTenant("demo");
  });
  afterAll(() => closeDb());

  it("does not reconcile a payment just because it succeeded", async () => {
    const p = await paidPayment(t);
    expect(p.status).toBe("successful");
    expect(p.reconciliationStatus).toBe("unreconciled");
  });

  it("matches a settlement file and flags exceptions", async () => {
    const a = await paidPayment(t, "10000");
    const b = await paidPayment(t, "2500");
    const file = csv([
      ["BNK-1", a.reference, t.accountCode, "credit", "10000.00", "SETTLED", "2026-11-02"],
      ["BNK-2", b.reference, t.accountCode, "credit", "2400.00", "SETTLED", "2026-11-02"],
      ["BNK-3", "SPC-000000-NOPE0000", t.accountCode, "credit", "5.00", "SETTLED", "2026-11-02"],
    ]);
    const parsed = await parseSettlementFile("s.csv", file);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const r = await importSettlement(getDb(), { organizationId: t.orgId, source: "file_import", scenario: "file", fileName: "s.csv", fileHash: fileHash(file), rows: parsed.rows }, { userId: t.financeUserId });
    expect(r.counts).toMatchObject({ matched: 1, amount_mismatch: 1, unmatched: 1 });
    const [pa] = await getDb().select().from(s.paymentIntents).where(eq(s.paymentIntents.id, a.id));
    const [pb] = await getDb().select().from(s.paymentIntents).where(eq(s.paymentIntents.id, b.id));
    expect(pa!.reconciliationStatus).toBe("reconciled");
    expect(pb!.reconciliationStatus).toBe("exception");

    // manual review with mandatory reason + audit trail
    const [rec] = await getDb().select().from(s.reconciliationRecords).where(eq(s.reconciliationRecords.paymentIntentId, b.id));
    await expect(resolveException(getDb(), { organizationId: t.orgId, recordId: rec!.id, decision: "manually_reconciled", reason: "curto" }, { userId: t.financeUserId })).rejects.toThrow();
    await resolveException(getDb(), { organizationId: t.orgId, recordId: rec!.id, decision: "manually_reconciled", reason: "Diferença de 100 MZN confirmada com o banco" }, { userId: t.financeUserId });
    const audit = await getDb().select().from(s.auditLogs).where(eq(s.auditLogs.action, "reconciliation.exception_reviewed"));
    expect(audit).toHaveLength(1);
  });

  it("rejects importing the same file twice and flags duplicate settlement references", async () => {
    const a = await paidPayment(t);
    const file = csv([["BNK-9", a.reference, t.accountCode, "credit", "10000", "SETTLED", "2026-11-02"]]);
    const parsed = await parseSettlementFile("a.csv", file);
    if (!parsed.ok) throw new Error("parse failed");
    const input = { organizationId: t.orgId, source: "file_import" as const, scenario: "file" as const, fileName: "a.csv", fileHash: fileHash(file), rows: parsed.rows };
    await importSettlement(getDb(), input, { userId: t.financeUserId });
    await expect(importSettlement(getDb(), input, { userId: t.financeUserId })).rejects.toThrow(/já foi importado/);

    // different file, same settlement reference => duplicate_settlement, payment not double-counted
    const file2 = Buffer.concat([file, Buffer.from("\n")]);
    const r2 = await importSettlement(getDb(), { ...input, fileHash: fileHash(file2) }, { userId: t.financeUserId });
    expect(r2.counts.duplicate_settlement).toBe(1);
  });
});

describe.skipIf(!hasDb)("tenant isolation (integration)", () => {
  beforeEach(() => truncateAll());
  afterAll(() => closeDb());

  it("a tenant's settlement file can never reconcile another tenant's payment", async () => {
    const a = await createTenant("demo");
    const b = await createTenant("othertenant");
    const pb = await paidPayment(b);
    const file = csv([["BNK-X", pb.reference, b.accountCode, "credit", "10000", "SETTLED", "2026-11-02"]]);
    const parsed = await parseSettlementFile("x.csv", file);
    if (!parsed.ok) throw new Error("parse failed");
    const r = await importSettlement(getDb(), { organizationId: a.orgId, source: "file_import", scenario: "file", fileName: "x.csv", fileHash: fileHash(file), rows: parsed.rows }, { userId: a.financeUserId });
    expect(r.counts.unmatched).toBe(1);
    const [after] = await getDb().select().from(s.paymentIntents).where(eq(s.paymentIntents.id, pb.id));
    expect(after!.reconciliationStatus).toBe("unreconciled");
  });

  it("tenant B cannot resolve tenant A's reconciliation records", async () => {
    const a = await createTenant("demo");
    const b = await createTenant("othertenant");
    const file = csv([["BNK-Y", "SPC-000000-NOPE0000", a.accountCode, "credit", "1", "SETTLED", "2026-11-02"]]);
    const parsed = await parseSettlementFile("y.csv", file);
    if (!parsed.ok) throw new Error("parse failed");
    await importSettlement(getDb(), { organizationId: a.orgId, source: "file_import", scenario: "file", fileName: "y.csv", fileHash: fileHash(file), rows: parsed.rows }, { userId: a.financeUserId });
    const [rec] = await getDb().select().from(s.reconciliationRecords);
    await expect(resolveException(getDb(), { organizationId: b.orgId, recordId: rec!.id, decision: "rejected", reason: "tentativa entre tenants" }, { userId: b.financeUserId })).rejects.toThrow(/não encontrado/);
  });
});

describe("excel export", () => {
  it("produces a readable workbook with exact amounts and the demo banner", async () => {
    const buf = await transactionsWorkbook([
      { reference: "SPC-1", customerName: "Ana", customerPhone: "+258841234567", debitNotes: "DN-1", amountMinor: 1_000_050, method: "M-Pesa", account: "Banco", status: "ok", reconciliationStatus: "reconciled", createdAt: new Date("2026-11-02T10:00:00Z") },
    ]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Transacções")!;
    expect(String(ws.getCell(1, 1).value)).toMatch(/DEMONSTRAÇÃO/);
    expect(ws.getCell(5, 1).value).toBe("SPC-1");
    expect(ws.getCell(5, 5).value).toBe(10000.5);
  });
});
