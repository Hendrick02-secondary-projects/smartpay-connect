/**
 * Demo seed — ALL data is synthetic. Run with: npm run db:seed
 *
 * Historical data (≈ 3 months) is written directly with back-dated timestamps, using the
 * SAME pure engines the app uses (commission engine, settlement scenarios, matcher), so the
 * numbers are internally consistent. The 10 000 MZN showcase is then executed end-to-end
 * through the real services (intent → signed webhook → accrual → settlement → reconciliation
 * → invoice → collection).
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { computeAccrual, invoiceStatusFor, selectApplicableRule } from "@/lib/commission/engine";
import { issueInvoiceForPayment, recordCollection } from "@/lib/commission/service";
import { changeAllocation } from "@/lib/kit/service";
import { closeProcess } from "@/lib/lifecycle/service";
import { applyRatePpm } from "@/lib/money";
import { getPaymentProvider } from "@/lib/payments/registry";
import { generatePaymentReference, PAYMENT_REFERENCE_PREFIX } from "@/lib/payments/rules";
import { authorizeSimulatedPayment, createPaymentIntent } from "@/lib/payments/service";
import { matchSettlementLines, type PaymentSnapshot } from "@/lib/reconciliation/matcher";
import { generateSimulatedSettlement, reconcileBatch } from "@/lib/reconciliation/service";
import { buildSettlementLines, SCENARIOS, SIMULATED_GATEWAY_FEE_PPM, type ScenarioKey } from "@/lib/settlement/scenarios";
import { sha256Hex } from "@/lib/security/crypto";

// ------------------------------------------------------------------ deterministic PRNG
let seed = 20261102;
function rand() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const int = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
const bytes = (n: number) => new Uint8Array(Array.from({ length: n }, () => int(0, 255)));

const FIRST = ["Ana", "Carlos", "Fátima", "João", "Lurdes", "Manuel", "Graça", "Hélder", "Isabel", "Domingos", "Celeste", "Armando", "Teresa", "Nelson", "Rosa", "Paulo", "Amélia", "Zacarias", "Joana", "Eduardo", "Albertina", "Félix", "Marta", "Ernesto"];
const LAST = ["Machava", "Cossa", "Sitoe", "Nhantumbo", "Langa", "Muianga", "Tembe", "Mabunda", "Nhaca", "Macuácua", "Bila", "Matsinhe", "Chauque", "Guambe", "Zandamela", "Novela", "Mucavele", "Manhiça"];
const COMPANIES = ["Transportes Kanimambo Lda (fictícia)", "Construções Xirico SA (fictícia)", "Farmácia Ntsindza (fictícia)", "Agro-Limpopo Lda (fictícia)"];

const DAY = 86_400_000;
const NOW = Date.now();

function maputoDate(daysAgo: number): Date {
  const base = new Date(NOW - daysAgo * DAY);
  const ymd = new Date(base.getTime() + 2 * 3600_000).toISOString().slice(0, 10);
  const hour = int(7, 19);
  const minute = int(0, 59);
  return new Date(`${ymd}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(int(0, 59)).padStart(2, "0")}+02:00`);
}

function phone(): string {
  let tail = "";
  do tail = String(int(1000000, 9999999)); while (["0001", "0002", "0003", "0004"].includes(tail.slice(-4)));
  return `+258${pick(["84", "85", "86", "87", "82", "83"])}${tail}`;
}

type Status = "successful" | "failed" | "cancelled" | "pending" | "reversed" | "created";

async function main() {
  const db = getDb();
  const existing = await db.select().from(s.organizations).where(eq(s.organizations.slug, "demo"));
  if (existing.length) {
    console.info("Database already seeded — run `npm run db:reset` for a fresh demo dataset.");
    return;
  }

  // ---------------------------------------------------------------- organisation & users
  const [org] = await db
    .insert(s.organizations)
    .values({ slug: "demo", name: "Demo Insurance Company", portalName: "SmartPay Payments", isDemo: true })
    .returning();
  const orgId = org!.id;

  const accounts = await db
    .insert(s.bankAccounts)
    .values([
      { organizationId: orgId, code: "DEMO-ALFA-01", bankName: "Banco Alfa (fictício)", accountName: "Demo Insurance — Prémios Automóvel", accountNumberMasked: "DEMO •••• 1001", purpose: "Seguro Automóvel", displayOrder: 1 },
      { organizationId: orgId, code: "DEMO-BETA-02", bankName: "Banco Beta (fictício)", accountName: "Demo Insurance — Prémios Saúde", accountNumberMasked: "DEMO •••• 2002", purpose: "Seguro de Saúde", displayOrder: 2 },
      { organizationId: orgId, code: "DEMO-GAMA-03", bankName: "Banco Gama (fictício)", accountName: "Demo Insurance — Prémios Vida", accountNumberMasked: "DEMO •••• 3003", purpose: "Seguro de Vida", displayOrder: 3 },
      { organizationId: orgId, code: "DEMO-DELTA-04", bankName: "Banco Delta (fictício)", accountName: "Demo Insurance — Ramos Gerais / Empresas", accountNumberMasked: "DEMO •••• 4004", purpose: "Ramos Gerais / Empresas", displayOrder: 4 },
    ])
    .returning();

  const financePassword = process.env.SEED_FINANCE_PASSWORD ?? "Finance#Demo2026";
  const ownerPassword = process.env.SEED_OWNER_PASSWORD ?? "Owner#Demo2026";
  const [finance] = await db
    .insert(s.users)
    .values({ organizationId: orgId, email: "finance@demo-insurance.test", name: "Utilizador Financeiro (demo)", passwordHash: await hashPassword(financePassword) })
    .returning();
  const [owner] = await db
    .insert(s.users)
    .values({ organizationId: null, email: "owner@smartpay-demo.test", name: "Proprietário SmartPay (demo)", passwordHash: await hashPassword(ownerPassword) })
    .returning();
  await db.insert(s.userRoles).values([
    { userId: finance!.id, role: "finance_user", organizationId: orgId },
    { userId: owner!.id, role: "platform_owner", organizationId: null },
  ]);

  // ---------------------------------------------------------------- commission rules
  const rules = await db
    .insert(s.commissionRules)
    .values([
      {
        organizationId: orgId,
        version: 1,
        ratePpm: 5_000,
        effectiveFrom: new Date("2026-01-01T00:00:00+02:00"),
        effectiveTo: null,
        status: "active",
        contractReference: "DEMO-CTR-INSURER-001",
        notes: "Taxa fictícia de demonstração (0,5%). Crie a v2 na consola para demonstrar versionamento sem efeitos retroactivos.",
        createdBy: owner!.id,
      },
    ])
    .returning();

  // ---------------------------------------------------------------- historical payments
  type Seeded = { id: string; reference: string; amountMinor: number; method: "card" | "mpesa" | "emola"; accountCode: string; status: Status; completedAt: Date | null; createdAt: Date; commissionMinor: number };
  const seeded: Seeded[] = [];
  const TOTAL = 184;

  for (let i = 0; i < TOTAL; i++) {
    const daysAgo = Math.floor(Math.pow(rand(), 0.85) * 92) + 1; // denser recent activity, never "today"
    const createdAt = maputoDate(daysAgo);
    const method = (() => {
      const r = rand();
      return r < 0.36 ? "card" : r < 0.8 ? "mpesa" : "emola";
    })() as Seeded["method"];
    const account = pick(accounts);
    const r = rand();
    let status: Status = r < 0.76 ? "successful" : r < 0.85 ? "failed" : r < 0.9 ? "cancelled" : r < 0.94 ? "reversed" : r < 0.97 ? "created" : "pending";
    if (status === "pending" && daysAgo > 4) status = "failed";

    const isCorporate = account.code === "DEMO-DELTA-04" && rand() < 0.6;
    const customerName = isCorporate ? pick(COMPANIES) : `${pick(FIRST)} ${pick(LAST)}`;
    const notesCount = rand() < 0.62 ? 1 : rand() < 0.8 ? 2 : 3;
    const notes = Array.from({ length: notesCount }, (_, n) => ({
      number: `DN-${createdAt.getUTCFullYear()}-${String(int(10000, 99999))}${n ? `-${n}` : ""}`,
      amountMinor: (isCorporate ? int(150, 4_800) : int(10, 900)) * 5_000 + pick([0, 0, 0, 2_500, 5_000]), // multiples of 50 MZN, some .25/.50
    }));
    const amountMinor = notes.reduce((a, n) => a + n.amountMinor, 0);
    const reference = generatePaymentReference(PAYMENT_REFERENCE_PREFIX, createdAt, bytes(8));
    const providerReference = `MOCK-${sha256Hex(`ref:${reference}`).slice(0, 20).toUpperCase()}`;
    const completedAt = status === "created" || status === "pending" ? null : new Date(createdAt.getTime() + int(20, 240) * 1000);
    const failureReason = status === "failed" ? pick(["INSUFFICIENT_FUNDS", "DECLINED_BY_ISSUER"]) : status === "cancelled" ? "CANCELLED_BY_CUSTOMER" : status === "reversed" ? "Chargeback simulado" : null;
    const statusChangedAt = status === "reversed" ? new Date(createdAt.getTime() + int(2, 6) * DAY) : (completedAt ?? createdAt);

    const [intent] = await db
      .insert(s.paymentIntents)
      .values({
        organizationId: orgId,
        reference,
        idempotencyKey: randomUUID(),
        requestHash: sha256Hex(reference),
        clientSecretHash: sha256Hex(randomUUID()),
        bankAccountId: account.id,
        customerName,
        customerPhone: phone(),
        paymentMethod: method,
        amountMinor,
        status,
        provider: "mock",
        providerReference,
        simulationScenario: status === "successful" || status === "reversed" ? "approve" : status === "failed" ? (failureReason === "INSUFFICIENT_FUNDS" ? "insufficient_funds" : "decline") : status === "cancelled" ? "cancel" : status === "pending" ? "pending" : null,
        failureReason,
        statusChangedAt,
        completedAt,
        createdAt,
        updatedAt: statusChangedAt,
      })
      .returning({ id: s.paymentIntents.id });
    const id = intent!.id;
    await db.insert(s.paymentDebitNotes).values(notes.map((n, idx) => ({ organizationId: orgId, paymentIntentId: id, debitNoteNumber: n.number, amountMinor: n.amountMinor, position: idx + 1, createdAt })));

    // Provider events (as if delivered by verified webhooks)
    const events: { type: string; from: Status | null; to: Status; at: Date }[] = [];
    if (status !== "created") events.push({ type: "payment.pending", from: "created", to: "pending", at: new Date(createdAt.getTime() + 5_000) });
    if (completedAt) {
      const final = status === "reversed" ? "successful" : status;
      events.push({ type: final === "successful" ? "payment.succeeded" : final === "failed" ? "payment.failed" : "payment.cancelled", from: "pending", to: final as Status, at: completedAt });
    }
    if (status === "reversed") events.push({ type: "payment.reversed", from: "successful", to: "reversed", at: statusChangedAt });
    if (events.length) {
      await db.insert(s.paymentEvents).values(
        events.map((e) => ({
          organizationId: orgId,
          paymentIntentId: id,
          provider: "mock",
          eventId: `mock_evt_${sha256Hex(`${reference}:${e.type}`).slice(0, 24)}`,
          eventType: e.type,
          fromStatus: e.from,
          toStatus: e.to,
          signatureValid: true,
          processingStatus: "processed" as const,
          payload: { seeded: true, eventType: e.type, paymentReference: reference },
          receivedAt: e.at,
          processedAt: e.at,
        })),
      );
    }

    let commissionMinor = 0;
    if (status === "successful" || status === "reversed") {
      await db.insert(s.paymentTransactions).values({
        organizationId: orgId,
        paymentIntentId: id,
        type: "charge",
        providerTransactionId: `mock_tx_${sha256Hex(`${reference}:charge`).slice(0, 20)}`,
        amountMinor,
        gatewayFeeMinor: applyRatePpm(amountMinor, SIMULATED_GATEWAY_FEE_PPM[method]),
        paymentMethod: method,
        processedAt: completedAt!,
        createdAt: completedAt!,
      });
      const rule = selectApplicableRule(rules, completedAt!)!;
      const acc = computeAccrual(amountMinor, rule);
      commissionMinor = acc.amountMinor;
      const [accrual] = await db
        .insert(s.commissionEntries)
        .values({ organizationId: orgId, paymentIntentId: id, entryType: "accrual", ...acc, reason: `Comissão contratual v${acc.ruleVersion} sobre pagamento elegível`, createdAt: completedAt! })
        .returning();
      if (status === "reversed") {
        await db.insert(s.paymentTransactions).values({
          organizationId: orgId,
          paymentIntentId: id,
          type: "reversal",
          providerTransactionId: `mock_tx_${sha256Hex(`${reference}:reversal`).slice(0, 20)}`,
          amountMinor,
          paymentMethod: method,
          processedAt: statusChangedAt,
          createdAt: statusChangedAt,
        });
        await db.insert(s.commissionEntries).values({
          organizationId: orgId,
          paymentIntentId: id,
          entryType: "reversal",
          ruleId: acc.ruleId,
          ruleVersion: acc.ruleVersion,
          ratePpm: acc.ratePpm,
          baseAmountMinor: amountMinor,
          amountMinor: -acc.amountMinor,
          compensatesEntryId: accrual!.id,
          reason: `Reversão do pagamento ${reference}: chargeback simulado`,
          createdAt: statusChangedAt,
        });
      }
    }
    seeded.push({ id, reference, amountMinor, method, accountCode: account.code, status, completedAt, createdAt, commissionMinor });
  }

  // ---------------------------------------------------------------- historical settlements & reconciliation
  // Weekly batches for successful payments older than 3 days; recent ones remain "awaiting reconciliation".
  const settleable = seeded
    .filter((p) => (p.status === "successful" || p.status === "reversed") && p.completedAt && p.completedAt.getTime() < NOW - 3 * DAY)
    .sort((a, b) => a.completedAt!.getTime() - b.completedAt!.getTime());
  const weeks = new Map<number, Seeded[]>();
  for (const p of settleable) {
    const w = Math.floor((NOW - p.completedAt!.getTime()) / (7 * DAY));
    weeks.set(w, [...(weeks.get(w) ?? []), p]);
  }
  // batch 3 = separate_fee_debit, batch 4 = aggregated (one bank credit), batch 5 = gross
  const scenarios: ScenarioKey[] = ["aggregated", "gross", "net", "separate_fee_debit"];
  const snapshots = new Map<string, PaymentSnapshot>(
    seeded.map((p) => [p.reference, { id: p.id, reference: p.reference, amountMinor: p.amountMinor, bankAccountCode: p.accountCode, status: p.status === "reversed" ? "successful" : p.status, alreadyReconciled: false }]),
  );
  const usedRefs = new Set<string>();
  let batchNo = 0;
  for (const [w, group] of [...weeks.entries()].sort((a, b) => b[0] - a[0])) {
    batchNo++;
    const scenario = scenarios[batchNo % scenarios.length]!;
    const valueDate = new Date(NOW - w * 7 * DAY + 2 * 3600_000).toISOString().slice(0, 10);
    const batchReference = `SIM-${valueDate.replace(/-/g, "")}-${String(batchNo).padStart(2, "0")}`;
    const lines = buildSettlementLines(
      scenario,
      batchReference,
      group.map((p) => ({ reference: p.reference, amountMinor: p.amountMinor, method: p.method, bankAccountCode: p.accountCode, commissionMinor: p.commissionMinor })),
    ).map((l, i) => ({ ...l, rowNumber: i + 1, valueDate }));

    // Deliberate exceptions in two batches so the demo has a review queue.
    if (batchNo === 3 && lines.length > 3) {
      lines[1] = { ...lines[1]!, grossAmountMinor: lines[1]!.grossAmountMinor - 15_000, netAmountMinor: lines[1]!.netAmountMinor - 15_000 }; // amount mismatch
      lines.push({ ...lines[0]!, rowNumber: lines.length + 1 }); // duplicate settlement reference
    }
    if (batchNo === 5 && lines.length > 2) {
      lines.push({ ...lines[0]!, settlementReference: `${batchReference}-X01`, paymentReference: "SPC-260801-UNKNOWN1", rowNumber: lines.length + 1 }); // unknown reference
      lines[2] = { ...lines[2]!, bankAccountCode: "DEMO-XXX-99" }; // account mismatch -> under review
    }

    const results = matchSettlementLines(lines, snapshots, usedRefs);
    const createdAt = new Date(`${valueDate}T18:00:00+02:00`);
    const matched = results.filter((r) => r.status === "matched").length;
    const [batch] = await db
      .insert(s.settlementBatches)
      .values({
        organizationId: orgId,
        batchReference,
        source: "simulated_provider",
        scenario,
        rowCount: lines.length,
        matchedCount: matched,
        exceptionCount: lines.length - matched,
        totalGrossMinor: lines.filter((l) => l.movementType === "credit").reduce((a, l) => a + l.grossAmountMinor, 0),
        createdBy: finance!.id,
        createdAt,
        reconciliationState: "reconciled",
        reconciledAt: createdAt,
        reconciledBy: finance!.id,
        feeTreatment: SCENARIOS[scenario].feeTreatment,
      })
      .returning();
    const idByRef = new Map<string, string>();
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      const r = results[i]!;
      const [stl] = await db
        .insert(s.bankSettlements)
        .values({
          organizationId: orgId,
          batchId: batch!.id,
          settlementReference: l.settlementReference,
          paymentReference: l.paymentReference,
          bankAccountCode: l.bankAccountCode,
          movementType: l.movementType,
          grossAmountMinor: l.grossAmountMinor,
          gatewayFeeMinor: l.gatewayFeeMinor,
          platformFeeMinor: l.platformFeeMinor,
          netAmountMinor: l.netAmountMinor,
          reportedStatus: l.reportedStatus,
          valueDate: l.valueDate,
          rowNumber: l.rowNumber,
          lineKind: l.lineKind,
          parentSettlementId: l.parentReference ? idByRef.get(l.parentReference)! : null,
          feeKind: l.feeKind,
          isDuplicateRow: r.isDuplicateRow,
          createdAt,
        })
        .returning({ id: s.bankSettlements.id });
      if (!idByRef.has(l.settlementReference)) idByRef.set(l.settlementReference, stl!.id);
      await db.insert(s.reconciliationRecords).values({
        organizationId: orgId,
        batchId: batch!.id,
        bankSettlementId: stl!.id,
        paymentIntentId: r.paymentId,
        status: r.status,
        reasonCode: r.reasonCode,
        expectedAmountMinor: r.expectedAmountMinor,
        settledAmountMinor: r.settledAmountMinor,
        differenceMinor: r.differenceMinor,
        createdAt,
        updatedAt: createdAt,
      });
      if (!r.isDuplicateRow) usedRefs.add(l.settlementReference);
      if (r.paymentId && l.movementType === "credit") {
        const snap = [...snapshots.values()].find((x) => x.id === r.paymentId)!;
        if (r.status === "matched") {
          snap.alreadyReconciled = true;
          await db.update(s.paymentIntents).set({ reconciliationStatus: "reconciled" }).where(eq(s.paymentIntents.id, r.paymentId));
        } else if (r.status !== "duplicate_settlement") {
          await db.update(s.paymentIntents).set({ reconciliationStatus: "exception" }).where(eq(s.paymentIntents.id, r.paymentId));
        }
      }
    }
  }

  // ---------------------------------------------------------------- invoices & collections (past months)
  const entries = await db.select().from(s.commissionEntries).where(eq(s.commissionEntries.organizationId, orgId));
  const byMonth = new Map<string, typeof entries>();
  for (const e of entries) {
    const ym = new Date(e.createdAt.getTime() + 2 * 3600_000).toISOString().slice(0, 7);
    byMonth.set(ym, [...(byMonth.get(ym) ?? []), e]);
  }
  const currentMonth = new Date(NOW + 2 * 3600_000).toISOString().slice(0, 7);
  const pastMonths = [...byMonth.keys()].filter((m) => m < currentMonth).sort();
  let invNo = 0;
  for (const [idx, ym] of pastMonths.entries()) {
    const monthEntries = byMonth.get(ym)!;
    const amount = monthEntries.reduce((a, e) => a + e.amountMinor, 0);
    if (amount <= 0) continue;
    invNo++;
    const [y, m] = ym.split("-").map(Number) as [number, number];
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    // m is 1-based, so Date.UTC(y, m, 3) is the 3rd of the FOLLOWING month (Dec rolls into Jan).
    const issuedAt = new Date(Math.min(Date.UTC(y, m, 3, 8), NOW - DAY));
    const isLast = idx === pastMonths.length - 1;
    const isSecondLast = idx === pastMonths.length - 2;
    // Oldest months fully collected; the previous month partially; the last closed month still open.
    const collected = isLast ? 0 : isSecondLast ? Math.floor(amount / 2) : amount;
    const [inv] = await db
      .insert(s.commissionInvoices)
      .values({
        organizationId: orgId,
        invoiceNumber: `SPC-INV-${ym.replace("-", "")}-${String(invNo).padStart(4, "0")}`,
        periodStart: `${ym}-01`,
        periodEnd: `${ym}-${String(lastDay).padStart(2, "0")}`,
        amountMinor: amount,
        status: invoiceStatusFor(amount, collected),
        issuedAt,
        createdBy: owner!.id,
        createdAt: issuedAt,
        updatedAt: issuedAt,
      })
      .returning();
    await db.insert(s.commissionInvoiceLines).values(monthEntries.map((e) => ({ invoiceId: inv!.id, commissionEntryId: e.id, amountMinor: e.amountMinor, createdAt: issuedAt })));
    if (collected > 0) {
      const receivedAt = new Date(issuedAt.getTime() + 12 * DAY);
      await db.insert(s.commissionPayouts).values({
        organizationId: orgId,
        invoiceId: inv!.id,
        amountMinor: collected,
        receivedAt,
        collectionReference: `DEMO-TRF-${ym.replace("-", "")}`,
        method: "bank_transfer",
        notes: "Cobrança simulada (seed).",
        recordedBy: owner!.id,
        createdAt: receivedAt,
      });
    }
  }

  // A compensating adjustment (current month, not yet invoiced)
  await db.insert(s.commissionEntries).values({
    organizationId: orgId,
    entryType: "adjustment",
    amountMinor: -2_500,
    reason: "Crédito de cortesia (fictício): atraso de liquidação simulado em lote anterior.",
    createdBy: owner!.id,
    createdAt: new Date(NOW - 2 * DAY),
  });

  // ---------------------------------------------------------------- V1.1: allocations, closures, timeline for history
  // Rebuild KIT allocations + lifecycle events for everything inserted above (same function as migration 0001).
  await db.execute(sql`select smartpay_backfill_v11()`);

  const days = (n: number) => n * DAY;
  const reconciledHistory = await db
    .select({ id: s.paymentIntents.id, completedAt: s.paymentIntents.completedAt, status: s.paymentIntents.status, recon: s.paymentIntents.reconciliationStatus })
    .from(s.paymentIntents)
    .where(eq(s.paymentIntents.organizationId, orgId));
  let allocatedTx = 0;
  let closedOps = 0;
  let partial = 0;
  let issues = 0;
  for (const p of reconciledHistory) {
    if (p.status !== "successful" || p.recon !== "reconciled" || !p.completedAt) continue;
    const age = (NOW - p.completedAt.getTime()) / DAY;
    if (age < 9) continue; // recent reconciled payments stay in the "to allocate" queue for the demo
    const allocs = await db.select().from(s.kitAllocations).where(eq(s.kitAllocations.paymentIntentId, p.id));
    const when = new Date(Math.min(p.completedAt.getTime() + days(int(5, 8)), NOW - days(1)));
    const mode = rand();
    for (const [i, a] of allocs.entries()) {
      if (mode < 0.05 && i === 0 && issues < 3) {
        await changeAllocation(db, { organizationId: orgId, allocationId: a.id, action: "flag_issue", expectedVersion: a.version, notes: "ND não encontrada no KIT — confirmar número com a área técnica." }, { userId: finance!.id }, when);
        issues++;
        break;
      }
      if (mode < 0.1 && i > 0 && partial < 4) {
        partial++;
        break; // leave the remaining debit notes "por alocar"
      }
      await changeAllocation(
        db,
        {
          organizationId: orgId,
          allocationId: a.id,
          action: "allocate",
          expectedVersion: a.version,
          receiptReference: `KIT-${new Date(when.getTime() + 2 * 3600_000).toISOString().slice(2, 10).replace(/-/g, "")}-${String(int(1000, 99999))}`,
          allocatedOn: new Date(when.getTime() + 2 * 3600_000).toISOString().slice(0, 10),
        },
        { userId: finance!.id },
        when,
      );
    }
    const refreshed = await db.select({ status: s.kitAllocations.status }).from(s.kitAllocations).where(eq(s.kitAllocations.paymentIntentId, p.id));
    if (refreshed.length && refreshed.every((r) => r.status === "allocated")) {
      allocatedTx++;
      if (age > 14 && rand() < 0.85) {
        await closeProcess(db, { kind: "operational", paymentIntentId: p.id, organizationId: orgId }, { userId: finance!.id }, new Date(when.getTime() + days(1)));
        closedOps++;
      }
    }
  }

  // Reversed payments whose allocations were annulled can be closed operationally.
  for (const p of reconciledHistory.filter((x) => x.status === "reversed")) {
    const allocs = await db.select({ status: s.kitAllocations.status }).from(s.kitAllocations).where(eq(s.kitAllocations.paymentIntentId, p.id));
    if (allocs.every((a) => a.status === "voided") && rand() < 0.6) {
      await closeProcess(db, { kind: "operational", paymentIntentId: p.id, organizationId: orgId, notes: "Pagamento revertido — nada a alocar." }, { userId: finance!.id }, new Date(NOW - days(int(2, 6))));
      closedOps++;
    }
  }

  // SmartPay financial closure where the commission invoice was fully collected.
  const paidCommission = await db.execute<{ id: string; at: Date }>(sql`
    select e.payment_intent_id as id, max(po.received_at) as at
      from commission_entries e
      join commission_invoice_lines l on l.commission_entry_id = e.id
      join commission_invoices i on i.id = l.invoice_id and i.status = 'paid'
      join commission_payouts po on po.invoice_id = i.id
     where e.payment_intent_id is not null and e.organization_id = ${orgId}
     group by e.payment_intent_id
    having not exists (select 1 from commission_entries e2 left join commission_invoice_lines l2 on l2.commission_entry_id = e2.id
                        left join commission_invoices i2 on i2.id = l2.invoice_id
                        where e2.payment_intent_id = e.payment_intent_id and (i2.id is null or i2.status <> 'paid'))`);
  let closedFin = 0;
  for (const row of paidCommission.rows) {
    await closeProcess(db, { kind: "financial", paymentIntentId: row.id, organizationId: null }, { userId: owner!.id }, new Date(Math.min(new Date(row.at).getTime() + days(1), NOW - days(1))));
    closedFin++;
  }

  // ---------------------------------------------------------------- showcase: 10 000 MZN end-to-end through real services
  const provider = getPaymentProvider();
  const intent = await createPaymentIntent(
    db,
    provider,
    "demo",
    {
      idempotencyKey: randomUUID(),
      bankAccountCode: "DEMO-ALFA-01",
      customerName: "Cenário Demo — Segurado Exemplo",
      customerPhone: "+258841230001", // test number …0001 => deterministic approval
      method: "mpesa",
      debitNotes: [
        { number: "DN-DEMO-10000-A", amount: 650_000 },
        { number: "DN-DEMO-10000-B", amount: 350_000 },
      ],
    },
    { ipHash: null },
  );
  const auth = await authorizeSimulatedPayment(db, provider, "demo", intent.reference, intent.clientSecret!, "approve");
  if (auth.status !== "successful") throw new Error(`Showcase payment did not succeed (${auth.status})`);
  const [showcase] = await db.select().from(s.paymentIntents).where(eq(s.paymentIntents.reference, intent.reference));
  // 1. bank settlement delivered by the simulated provider (pending) -> 2. reconciled by Finance
  const settled = await generateSimulatedSettlement(db, provider, { organizationId: orgId, scenario: "gross", paymentIds: [showcase!.id] }, { userId: null });
  await reconcileBatch(db, { organizationId: orgId, batchId: settled.batch.id }, { userId: finance!.id });
  // 3. each debit note allocated in KIT -> 4. insurer operational closure
  const showcaseAllocs = await db.select().from(s.kitAllocations).where(eq(s.kitAllocations.paymentIntentId, showcase!.id));
  const today = new Date(NOW + 2 * 3600_000).toISOString().slice(0, 10);
  for (const [i, a] of showcaseAllocs.entries()) {
    await changeAllocation(
      db,
      { organizationId: orgId, allocationId: a.id, action: "allocate", expectedVersion: a.version, receiptReference: `KIT-DEMO-10000-${i + 1}`, allocatedOn: today },
      { userId: finance!.id },
    );
  }
  await closeProcess(db, { kind: "operational", paymentIntentId: showcase!.id, organizationId: orgId, notes: "Cenário de demonstração concluído." }, { userId: finance!.id });
  // 5. commission invoiced and (simulated) collected -> 6. SmartPay financial closure
  const inv = await issueInvoiceForPayment(db, { paymentIntentId: showcase!.id }, { userId: owner!.id });
  await recordCollection(
    db,
    { invoiceId: inv.id, amountMinor: inv.amountMinor, receivedAt: new Date(), collectionReference: "DEMO-TRF-SHOWCASE-10000", method: "bank_transfer", notes: "Cobrança simulada do cenário 10 000 MZN." },
    { userId: owner!.id },
  );
  await closeProcess(db, { kind: "financial", paymentIntentId: showcase!.id, organizationId: null }, { userId: owner!.id });

  // A provider settlement waiting for Finance at the start of the demo: ONE aggregated bank credit.
  const waiting = await generateSimulatedSettlement(db, provider, { organizationId: orgId, scenario: "aggregated", limit: 3 }, { userId: null }).catch(() => null);

  const count = seeded.length + 1;
  console.info(`✓ Seeded ${count} simulated payments, ${batchNo + 1} settlement batches, ${invNo + 1} invoices.`);
  console.info(`  Showcase: ${intent.reference} — 10 000,00 MZN → commission ${inv.amountMinor / 100} MZN accrued, invoiced and collected.`);
  console.info("  Finance login: finance@demo-insurance.test  (password: SEED_FINANCE_PASSWORD)");
  console.info("  Owner login:   owner@smartpay-demo.test    (password: SEED_OWNER_PASSWORD) at /owner/login");
}

main()
  .catch((err) => {
    console.error("Seed failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
