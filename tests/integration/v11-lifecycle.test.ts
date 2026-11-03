import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, getDb } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { login } from "@/lib/auth/service";
import { can } from "@/lib/auth/policy";
import { issueInvoiceForPayment, recordCollection } from "@/lib/commission/service";
import { demoSettlement } from "@/lib/demo/service";
import { changeAllocation } from "@/lib/kit/service";
import { closeProcess, getLifecycle, listTimeline, reopenProcess } from "@/lib/lifecycle/service";
import { authorizeSimulatedPayment, createPaymentIntent, processProviderWebhook, reverseSimulatedPayment } from "@/lib/payments/service";
import { generateSimulatedSettlement, reconcileBatch } from "@/lib/reconciliation/service";
import { createPaymentSchema } from "@/lib/validation/payment";
import { createOwner, createTenant, hasDb, PASSWORD, paymentInput, provider, truncateAll, type Tenant } from "./helpers";

const cookieJar = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (cookieJar.token ? { value: cookieJar.token } : undefined), set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

async function paid(t: Tenant, notes: { number: string; amount: string }[] = [{ number: "DN-1001", amount: "6500" }, { number: "DN-1002", amount: "3500" }]) {
  const p = provider();
  const input = createPaymentSchema.parse({ ...paymentInput(t, { notes }), debitNotes: notes });
  const r = await createPaymentIntent(getDb(), p, t.slug, input, { ipHash: `ip-${Math.random()}` });
  await authorizeSimulatedPayment(getDb(), p, t.slug, r.reference, r.clientSecret!, "approve");
  const [intent] = await getDb().select().from(s.paymentIntents).where(eq(s.paymentIntents.reference, r.reference));
  return intent!;
}

async function reconciled(t: Tenant, notes?: { number: string; amount: string }[]) {
  const intent = await paid(t, notes);
  const batch = await generateSimulatedSettlement(getDb(), provider(), { organizationId: t.orgId, scenario: "gross", paymentIds: [intent.id] }, { userId: null });
  await reconcileBatch(getDb(), { organizationId: t.orgId, batchId: batch.batch.id }, { userId: t.financeUserId });
  return intent;
}

const allocationsOf = (paymentId: string) => getDb().select().from(s.kitAllocations).where(eq(s.kitAllocations.paymentIntentId, paymentId));
const today = () => new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);

async function allocateAll(t: Tenant, paymentId: string, prefix = "KIT-R") {
  for (const [i, a] of (await allocationsOf(paymentId)).entries()) {
    await changeAllocation(getDb(), { organizationId: t.orgId, allocationId: a.id, action: "allocate", expectedVersion: a.version, receiptReference: `${prefix}-${i + 1}`, allocatedOn: today() }, { userId: t.financeUserId });
  }
}

describe.skipIf(!hasDb)("V1.1 — KIT allocation", () => {
  let t: Tenant;
  beforeEach(async () => {
    await truncateAll();
    t = await createTenant("demo");
  });
  afterAll(() => closeDb());

  it("opens one pending allocation per debit note when the payment succeeds", async () => {
    const p = await paid(t);
    const allocs = await allocationsOf(p.id);
    expect(allocs.map((a) => a.status)).toEqual(["pending", "pending"]);
  });

  it("cannot allocate before bank reconciliation", async () => {
    const p = await paid(t);
    const [a] = await allocationsOf(p.id);
    await expect(
      changeAllocation(getDb(), { organizationId: t.orgId, allocationId: a!.id, action: "allocate", expectedVersion: 1, receiptReference: "KIT-1", allocatedOn: today() }, { userId: t.financeUserId }),
    ).rejects.toThrow(/reconciliado/);
  });

  it("a transaction is fully allocated only when ALL debit notes are allocated", async () => {
    const p = await reconciled(t);
    const [a1, a2] = await allocationsOf(p.id);
    await changeAllocation(getDb(), { organizationId: t.orgId, allocationId: a1!.id, action: "allocate", expectedVersion: 1, receiptReference: "KIT-1", allocatedOn: today() }, { userId: t.financeUserId });
    expect((await getLifecycle(getDb(), p.id))!.facts.allocations.state).toBe("partial");
    await expect(closeProcess(getDb(), { kind: "operational", paymentIntentId: p.id, organizationId: t.orgId }, { userId: t.financeUserId })).rejects.toThrow(/Faltam alocar 1 de 2/);
    await changeAllocation(getDb(), { organizationId: t.orgId, allocationId: a2!.id, action: "allocate", expectedVersion: 1, receiptReference: "KIT-2", allocatedOn: today() }, { userId: t.financeUserId });
    expect((await getLifecycle(getDb(), p.id))!.facts.allocations.state).toBe("complete");
  });

  it("rejects stale writes from a second user (optimistic version)", async () => {
    const p = await reconciled(t);
    const [a] = await allocationsOf(p.id);
    await changeAllocation(getDb(), { organizationId: t.orgId, allocationId: a!.id, action: "flag_issue", expectedVersion: 1, notes: "ND não encontrada no KIT" }, { userId: t.financeUserId });
    await expect(
      changeAllocation(getDb(), { organizationId: t.orgId, allocationId: a!.id, action: "allocate", expectedVersion: 1, receiptReference: "KIT-1", allocatedOn: today() }, { userId: t.financeUserId }),
    ).rejects.toThrow(/outro utilizador/);
  });

  it("a KIT receipt cannot be reused for another transaction", async () => {
    const p1 = await reconciled(t, [{ number: "DN-A1", amount: "100" }]);
    const p2 = await reconciled(t, [{ number: "DN-B1", amount: "200" }]);
    await allocateAll(t, p1.id, "KIT-SAME");
    const [b] = await allocationsOf(p2.id);
    await expect(
      changeAllocation(getDb(), { organizationId: t.orgId, allocationId: b!.id, action: "allocate", expectedVersion: 1, receiptReference: "KIT-SAME-1", allocatedOn: today() }, { userId: t.financeUserId }),
    ).rejects.toThrow(/já está associado/);
  });
});

describe.skipIf(!hasDb)("V1.1 — closures are independent", () => {
  let t: Tenant;
  beforeEach(async () => {
    await truncateAll();
    t = await createTenant("demo");
  });
  afterAll(() => closeDb());

  it("the insurer closes operationally before SmartPay collects; SmartPay closes after collection", async () => {
    const owner = await createOwner();
    const p = await reconciled(t);
    await allocateAll(t, p.id);
    await closeProcess(getDb(), { kind: "operational", paymentIntentId: p.id, organizationId: t.orgId }, { userId: t.financeUserId });
    await expect(closeProcess(getDb(), { kind: "financial", paymentIntentId: p.id, organizationId: null }, { userId: owner.userId })).rejects.toThrow(/facturar/);
    const inv = await issueInvoiceForPayment(getDb(), { paymentIntentId: p.id }, { userId: owner.userId });
    expect(inv.amountMinor).toBe(5_000);
    await expect(closeProcess(getDb(), { kind: "financial", paymentIntentId: p.id, organizationId: null }, { userId: owner.userId })).rejects.toThrow(/recebida/);
    await recordCollection(getDb(), { invoiceId: inv.id, amountMinor: 5_000, receivedAt: new Date(), collectionReference: "TRF-1", method: "bank_transfer" }, { userId: owner.userId });
    await closeProcess(getDb(), { kind: "financial", paymentIntentId: p.id, organizationId: null }, { userId: owner.userId });
    const lc = (await getLifecycle(getDb(), p.id))!;
    expect(lc.stages.every((st) => st.state === "done")).toBe(true);
  });

  it("closed transactions freeze allocations until reopened with a reason", async () => {
    const p = await reconciled(t);
    await allocateAll(t, p.id);
    await closeProcess(getDb(), { kind: "operational", paymentIntentId: p.id, organizationId: t.orgId }, { userId: t.financeUserId });
    const [a] = await allocationsOf(p.id);
    await expect(
      changeAllocation(getDb(), { organizationId: t.orgId, allocationId: a!.id, action: "reset", expectedVersion: a!.version, notes: "Recibo com valor errado" }, { userId: t.financeUserId }),
    ).rejects.toThrow(/encerrada/);
    await expect(reopenProcess(getDb(), { kind: "operational", paymentIntentId: p.id, organizationId: t.orgId, reason: "curto" }, { userId: t.financeUserId })).rejects.toThrow();
    await reopenProcess(getDb(), { kind: "operational", paymentIntentId: p.id, organizationId: t.orgId, reason: "Recibo KIT com valor errado" }, { userId: t.financeUserId });
    await changeAllocation(getDb(), { organizationId: t.orgId, allocationId: a!.id, action: "reset", expectedVersion: a!.version, notes: "Recibo com valor errado" }, { userId: t.financeUserId });
  });

  it("a reversal reopens both closures, voids unallocated notes and keeps allocated ones for manual annulment", async () => {
    const owner = await createOwner();
    const p = await reconciled(t);
    const [a1] = await allocationsOf(p.id);
    await changeAllocation(getDb(), { organizationId: t.orgId, allocationId: a1!.id, action: "allocate", expectedVersion: 1, receiptReference: "KIT-1", allocatedOn: today() }, { userId: t.financeUserId });
    await reverseSimulatedPayment(getDb(), provider(), p.id, "Chargeback de teste simulado", owner.userId);
    const after = await allocationsOf(p.id);
    expect(after.map((a) => a.status).sort()).toEqual(["allocated", "voided"]);
    const lc = (await getLifecycle(getDb(), p.id))!;
    expect(lc.canCloseOperational.ok).toBe(false);
    const still = after.find((a) => a.status === "allocated")!;
    await changeAllocation(getDb(), { organizationId: t.orgId, allocationId: still.id, action: "void", expectedVersion: still.version, notes: "Anulado no KIT após chargeback", receiptReference: "KIT-ANUL-1" }, { userId: t.financeUserId });
    await closeProcess(getDb(), { kind: "operational", paymentIntentId: p.id, organizationId: t.orgId }, { userId: t.financeUserId });
    // commission cancelled out (accrual + reversal, nothing invoiced) -> SmartPay can close too
    await closeProcess(getDb(), { kind: "financial", paymentIntentId: p.id, organizationId: null }, { userId: owner.userId });
  });

  it("an operational closure is reopened automatically if the payment is reversed later", async () => {
    const owner = await createOwner();
    const p = await reconciled(t);
    await allocateAll(t, p.id);
    await closeProcess(getDb(), { kind: "operational", paymentIntentId: p.id, organizationId: t.orgId }, { userId: t.financeUserId });
    await reverseSimulatedPayment(getDb(), provider(), p.id, "Chargeback após encerramento", owner.userId);
    const closures = await getDb().select().from(s.paymentClosures).where(eq(s.paymentClosures.paymentIntentId, p.id));
    expect(closures).toHaveLength(1);
    expect(closures[0]!.reopenedAt).not.toBe(null);
    expect(closures[0]!.reopenedBy).toBe(null); // system
  });
});

describe.skipIf(!hasDb)("V1.1 — settlement, reconciliation and duplicates", () => {
  let t: Tenant;
  beforeEach(async () => {
    await truncateAll();
    t = await createTenant("demo");
  });
  afterAll(() => closeDb());

  it("a provider settlement waits for Finance: receiving money is not reconciling it", async () => {
    const p = await paid(t);
    const b = await generateSimulatedSettlement(getDb(), provider(), { organizationId: t.orgId, scenario: "net", paymentIds: [p.id] }, { userId: null });
    const [still] = await getDb().select().from(s.paymentIntents).where(eq(s.paymentIntents.id, p.id));
    expect(still!.reconciliationStatus).toBe("unreconciled");
    expect((await getLifecycle(getDb(), p.id))!.facts.settlement).toMatchObject({ lines: 1, awaitingReconciliation: true });
    await reconcileBatch(getDb(), { organizationId: t.orgId, batchId: b.batch.id }, { userId: t.financeUserId });
    await expect(reconcileBatch(getDb(), { organizationId: t.orgId, batchId: b.batch.id }, { userId: t.financeUserId })).rejects.toThrow(/já foi reconciliado/);
    const [done] = await getDb().select().from(s.paymentIntents).where(eq(s.paymentIntents.id, p.id));
    expect(done!.reconciliationStatus).toBe("reconciled");
  });

  it("aggregated settlement: ONE bank credit reconciles several payments", async () => {
    const owner = await createOwner();
    const ps = [await paid(t, [{ number: "DN-X1", amount: "100" }]), await paid(t, [{ number: "DN-X2", amount: "200" }]), await paid(t, [{ number: "DN-X3", amount: "300" }])];
    const r = await demoSettlement(getDb(), provider(), ps[0]!.id, "aggregated", { userId: owner.userId });
    expect(r.payments).toBe(3);
    const lines = await getDb().select().from(s.bankSettlements).where(eq(s.bankSettlements.batchId, r.batch.id));
    expect(lines.filter((l) => l.lineKind === "statement")).toHaveLength(1);
    expect(lines.filter((l) => l.lineKind === "detail")).toHaveLength(3);
    const rec = await reconcileBatch(getDb(), { organizationId: t.orgId, batchId: r.batch.id }, { userId: t.financeUserId });
    expect(rec.counts.matched).toBe(4);
    const after = await getDb().select().from(s.paymentIntents).where(eq(s.paymentIntents.organizationId, t.orgId));
    expect(after.every((p) => p.reconciliationStatus === "reconciled")).toBe(true);
  });

  it("duplicate submissions and webhook redeliveries do not duplicate allocations or timeline events", async () => {
    const p = provider();
    const input = createPaymentSchema.parse({ ...paymentInput(t), debitNotes: [{ number: "DN-1001", amount: "100" }] });
    const [a, b] = await Promise.all([
      createPaymentIntent(getDb(), p, "demo", input, { ipHash: "ip" }),
      createPaymentIntent(getDb(), p, "demo", input, { ipHash: "ip" }),
    ]);
    expect(a.reference).toBe(b.reference);
    const secret = a.clientSecret ?? b.clientSecret!;
    await authorizeSimulatedPayment(getDb(), p, "demo", a.reference, secret, "approve");
    const [intent] = await getDb().select().from(s.paymentIntents).where(eq(s.paymentIntents.reference, a.reference));
    const hooks = p.simulateCheckout({ reference: intent!.reference, providerReference: intent!.providerReference!, amountMinor: intent!.amountMinor, method: "card", scenario: "approve" });
    for (const h of hooks) expect((await processProviderWebhook(getDb(), p, h.rawBody, new Headers(h.headers))).result).toBe("duplicate");
    expect(await allocationsOf(intent!.id)).toHaveLength(1);
    const succeeded = await getDb()
      .select()
      .from(s.lifecycleEvents)
      .where(and(eq(s.lifecycleEvents.paymentIntentId, intent!.id), eq(s.lifecycleEvents.eventType, "payment.successful")));
    expect(succeeded).toHaveLength(1);
  });

  it("the tenant timeline hides SmartPay commission events; the platform timeline shows them", async () => {
    const p = await reconciled(t);
    const tenant = await listTimeline(getDb(), p.id, "tenant");
    const platform = await listTimeline(getDb(), p.id, "platform");
    expect(tenant.some((e) => e.stage.startsWith("commission"))).toBe(false);
    expect(platform.some((e) => e.stage === "commission_accrual")).toBe(true);
    expect(tenant.map((e) => e.stage)).toContain("reconciliation");
  });
});

describe.skipIf(!hasDb)("V1.1 — isolation between users and tenants", () => {
  beforeEach(async () => {
    await truncateAll();
    cookieJar.token = undefined;
  });
  afterAll(() => closeDb());

  it("finance of tenant B cannot touch tenant A's allocations or closures", async () => {
    const a = await createTenant("demo");
    const b = await createTenant("othertenant");
    const p = await reconciled(a);
    const [alloc] = await allocationsOf(p.id);
    await expect(
      changeAllocation(getDb(), { organizationId: b.orgId, allocationId: alloc!.id, action: "allocate", expectedVersion: 1, receiptReference: "KIT-X", allocatedOn: today() }, { userId: b.financeUserId }),
    ).rejects.toThrow(/não encontrada/);
    await expect(closeProcess(getDb(), { kind: "operational", paymentIntentId: p.id, organizationId: b.orgId }, { userId: b.financeUserId })).rejects.toThrow(/não encontrada/);
  });

  it("the platform owner can simulate events but cannot reconcile, allocate or close operationally", async () => {
    const t = await createTenant("demo");
    const owner = await createOwner();
    const r = await login(getDb(), { email: owner.email, password: PASSWORD, ipHash: "o", userAgent: null, portal: "owner" });
    if (!r.ok) throw new Error("owner login failed");
    expect(can(r.principal, "tenant:kit:allocate", t.orgId)).toBe(false);
    expect(can(r.principal, "tenant:reconciliation:write", t.orgId)).toBe(false);
    expect(can(r.principal, "platform:demo:control")).toBe(true);

    cookieJar.token = r.token;
    const p = await reconciled(t);
    const [alloc] = await allocationsOf(p.id);
    const req = (url: string, body: unknown) =>
      new Request(url, { method: "POST", headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify(body) });
    const { POST: allocate } = await import("@/app/api/finance/allocations/[id]/route");
    const { POST: close } = await import("@/app/api/finance/transactions/[id]/closure/route");
    const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
    expect((await allocate(req("http://localhost/x", { action: "allocate", expectedVersion: 1, receiptReference: "KIT-1", allocatedOn: today() }), ctx(alloc!.id))).status).toBe(403);
    expect((await close(req("http://localhost/x", { action: "close" }), ctx(p.id))).status).toBe(403);
  });

  it("finance users cannot close SmartPay's financial process", async () => {
    const t = await createTenant("demo");
    const r = await login(getDb(), { email: t.financeEmail, password: PASSWORD, ipHash: "f", userAgent: null, portal: "tenant" });
    if (!r.ok) throw new Error("login failed");
    cookieJar.token = r.token;
    const p = await reconciled(t);
    const { POST } = await import("@/app/api/owner/transactions/[id]/financial-closure/route");
    const res = await POST(
      new Request("http://localhost/x", { method: "POST", headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ action: "close" }) }),
      { params: Promise.resolve({ id: p.id }) },
    );
    expect(res.status).toBe(403);
  });
});
