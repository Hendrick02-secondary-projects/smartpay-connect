import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { authorizeSimulatedPayment, createPaymentIntent, processProviderWebhook, resolvePendingPayment } from "@/lib/payments/service";
import { createPaymentSchema } from "@/lib/validation/payment";
import { createTenant, hasDb, paymentInput, provider, truncateAll, type Tenant } from "./helpers";

describe.skipIf(!hasDb)("payments (integration)", () => {
  let t: Tenant;
  beforeEach(async () => {
    await truncateAll();
    t = await createTenant("demo");
  });
  afterAll(() => closeDb());

  it("validates customer input with the shared schema", () => {
    const bad = createPaymentSchema.safeParse({ ...paymentInput(t), customerPhone: "123", customerName: "x", debitNotes: [] });
    expect(bad.success).toBe(false);
    const paths = bad.success ? [] : bad.error.issues.map((i) => i.path.join("."));
    expect(paths).toContain("customerPhone");
    expect(paths).toContain("customerName");
    expect(paths).toContain("debitNotes");
  });

  it("stores multiple debit notes and the exact total", async () => {
    const input = createPaymentSchema.parse({
      ...paymentInput(t),
      debitNotes: [
        { number: "dn-1001", amount: "6 500,00" },
        { number: "DN-1002", amount: "3500" },
      ],
    });
    const r = await createPaymentIntent(getDb(), provider(), "demo", input, { ipHash: "ip1" });
    const [intent] = await getDb().select().from(s.paymentIntents).where(eq(s.paymentIntents.reference, r.reference));
    expect(intent!.amountMinor).toBe(1_000_000);
    const notes = await getDb().select().from(s.paymentDebitNotes).where(eq(s.paymentDebitNotes.paymentIntentId, intent!.id));
    expect(notes.map((n) => n.debitNoteNumber).sort()).toEqual(["DN-1001", "DN-1002"]);
  });

  it("rejects repeated debit notes in the same payment", () => {
    const r = createPaymentSchema.safeParse({ ...paymentInput(t), debitNotes: [{ number: "DN-1000", amount: "10" }, { number: "dn-1000", amount: "20" }] });
    expect(r.success).toBe(false);
  });

  it("prevents duplicate payment creation with an idempotency key", async () => {
    const input = createPaymentSchema.parse({ ...paymentInput(t), debitNotes: [{ number: "DN-1001", amount: "100" }] });
    const [a, b] = await Promise.all([
      createPaymentIntent(getDb(), provider(), "demo", input, { ipHash: "ip" }),
      createPaymentIntent(getDb(), provider(), "demo", input, { ipHash: "ip" }),
    ]);
    expect(a.reference).toBe(b.reference);
    const [{ n }] = (await getDb().select({ n: sql<number>`count(*)::int` }).from(s.paymentIntents)) as [{ n: number }];
    expect(n).toBe(1);
    // same key, different data => 409
    const changed = createPaymentSchema.parse({ ...paymentInput(t, { key: input.idempotencyKey }), debitNotes: [{ number: "DN-1001", amount: "999" }] });
    await expect(createPaymentIntent(getDb(), provider(), "demo", changed, { ipHash: "ip" })).rejects.toThrow(/dados diferentes/);
  });

  it("runs the full simulated checkout and accrues commission exactly once", async () => {
    const input = createPaymentSchema.parse({ ...paymentInput(t), debitNotes: [{ number: "DN-1001", amount: "10000" }] });
    const p = provider();
    const r = await createPaymentIntent(getDb(), p, "demo", input, { ipHash: "ip" });
    const res = await authorizeSimulatedPayment(getDb(), p, "demo", r.reference, r.clientSecret!, "approve");
    expect(res.status).toBe("successful");
    // double click: same events re-sent -> duplicates, no second accrual
    const again = await authorizeSimulatedPayment(getDb(), p, "demo", r.reference, r.clientSecret!, "approve");
    expect(again.status).toBe("successful");
    const entries = await getDb().select().from(s.commissionEntries);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.amountMinor).toBe(5_000); // 10 000 MZN × 0.5% = 50 MZN
  });

  it("supports pending -> successful via simulated async callback, and rejects wrong client secrets", async () => {
    const input = createPaymentSchema.parse({ ...paymentInput(t, { method: "mpesa", phone: "+258840000003" }), debitNotes: [{ number: "DN-1001", amount: "500" }] });
    const p = provider();
    const r = await createPaymentIntent(getDb(), p, "demo", input, { ipHash: "ip" });
    const res = await authorizeSimulatedPayment(getDb(), p, "demo", r.reference, r.clientSecret!, "approve");
    expect(res.status).toBe("pending"); // test number …0003 forces "pending"
    await expect(resolvePendingPayment(getDb(), p, "demo", r.reference, "x".repeat(32), "approve")).rejects.toThrow(/não encontrado/);
    const done = await resolvePendingPayment(getDb(), p, "demo", r.reference, r.clientSecret!, "approve");
    expect(done.status).toBe("successful");
  });

  it("deduplicates webhooks, rejects bad signatures and invalid transitions", async () => {
    const input = createPaymentSchema.parse({ ...paymentInput(t), debitNotes: [{ number: "DN-1001", amount: "100" }] });
    const p = provider();
    const r = await createPaymentIntent(getDb(), p, "demo", input, { ipHash: "ip" });
    const [intent] = await getDb().select().from(s.paymentIntents).where(eq(s.paymentIntents.reference, r.reference));
    const params = { reference: r.reference, providerReference: intent!.providerReference!, amountMinor: intent!.amountMinor, method: "card" as const };
    const [pending, failed] = p.simulateCheckout({ ...params, scenario: "decline" });

    expect((await processProviderWebhook(getDb(), p, pending!.rawBody, new Headers(pending!.headers))).result).toBe("processed");
    expect((await processProviderWebhook(getDb(), p, pending!.rawBody, new Headers(pending!.headers))).result).toBe("duplicate");

    const tampered = new Headers({ ...failed!.headers, "x-smartpay-mock-signature": "0".repeat(64) });
    expect((await processProviderWebhook(getDb(), p, failed!.rawBody, tampered)).result).toBe("rejected");

    expect((await processProviderWebhook(getDb(), p, failed!.rawBody, new Headers(failed!.headers))).result).toBe("processed");
    // failed -> successful is illegal
    const success = p.resolvePending(params, "approve");
    const out = await processProviderWebhook(getDb(), p, success.rawBody, new Headers(success.headers));
    expect(out).toMatchObject({ result: "ignored" });
    const [after] = await getDb().select().from(s.paymentIntents).where(eq(s.paymentIntents.id, intent!.id));
    expect(after!.status).toBe("failed");
  });

  it("database trigger blocks illegal transitions and financial edits even outside the app", async () => {
    const input = createPaymentSchema.parse({ ...paymentInput(t), debitNotes: [{ number: "DN-1001", amount: "100" }] });
    const r = await createPaymentIntent(getDb(), provider(), "demo", input, { ipHash: "ip" });
    await expect(getDb().update(s.paymentIntents).set({ status: "reversed" }).where(eq(s.paymentIntents.reference, r.reference))).rejects.toThrow();
    await expect(getDb().update(s.paymentIntents).set({ amountMinor: 1 }).where(eq(s.paymentIntents.reference, r.reference))).rejects.toThrow();
    await expect(getDb().delete(s.paymentIntents).where(eq(s.paymentIntents.reference, r.reference))).rejects.toThrow();
  });
});
