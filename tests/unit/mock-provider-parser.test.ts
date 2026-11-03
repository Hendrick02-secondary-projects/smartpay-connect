import { describe, expect, it } from "vitest";
import { MockPaymentProvider, scenarioFromTestPhone } from "@/lib/payments/mock-provider";
import { mapRows, parseCsv } from "@/lib/reconciliation/parser";

const clock = () => new Date("2026-11-02T10:00:00Z");
const p = new MockPaymentProvider("unit-test-secret-0123456789", async () => null, clock);
const params = { reference: "SPC-261102-AAAA0000", providerReference: "MOCK-X", amountMinor: 1_000_000, method: "card" as const };

describe("MockPaymentProvider", () => {
  it("signs webhooks that verify, with deterministic event ids", () => {
    const hooks = p.simulateCheckout({ ...params, scenario: "approve" });
    expect(hooks).toHaveLength(2);
    const v = p.verifyWebhook(hooks[1]!.rawBody, new Headers(hooks[1]!.headers));
    expect(v.valid).toBe(true);
    if (v.valid) {
      expect(v.event.status).toBe("successful");
      expect(v.event.gatewayFeeMinor).toBe(25_000); // fictional 2.5% card fee
    }
    const again = p.simulateCheckout({ ...params, scenario: "approve" });
    expect(JSON.parse(again[1]!.rawBody).eventId).toBe(JSON.parse(hooks[1]!.rawBody).eventId);
  });

  it("rejects tampered bodies, wrong secrets and stale timestamps", () => {
    const [hook] = p.simulateCheckout({ ...params, scenario: "decline" });
    const tampered = hook!.rawBody.replace('"amountMinor":1000000', '"amountMinor":1');
    expect(p.verifyWebhook(tampered, new Headers(hook!.headers))).toMatchObject({ valid: false, reason: "bad_signature" });
    const other = new MockPaymentProvider("another-secret-0123456789", async () => null, clock);
    expect(other.verifyWebhook(hook!.rawBody, new Headers(hook!.headers))).toMatchObject({ valid: false, reason: "bad_signature" });
    const later = new MockPaymentProvider("unit-test-secret-0123456789", async () => null, () => new Date("2026-11-02T11:00:00Z"));
    expect(later.verifyWebhook(hook!.rawBody, new Headers(hook!.headers))).toMatchObject({ valid: false, reason: "stale_timestamp" });
    expect(p.verifyWebhook(hook!.rawBody, new Headers())).toMatchObject({ valid: false, reason: "missing_signature" });
  });

  it("maps deterministic mobile-money test numbers", () => {
    expect(scenarioFromTestPhone("mpesa", "+258840000001")).toBe("approve");
    expect(scenarioFromTestPhone("emola", "+258860000002")).toBe("insufficient_funds");
    expect(scenarioFromTestPhone("mpesa", "+258840000003")).toBe("pending");
    expect(scenarioFromTestPhone("card", "+258840000001")).toBeNull();
    expect(scenarioFromTestPhone("mpesa", "+258841234567")).toBeNull();
  });
});

describe("settlement file parser", () => {
  it("parses quoted CSV with ; or , delimiters", () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi"""\r\n')).toEqual([
      ["a", "b"],
      ["x, y", 'he said "hi"'],
    ]);
    expect(parseCsv("a;b\n1;2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("maps rows with exact minor-unit amounts and normalised dates", () => {
    const r = mapRows(
      parseCsv(
        "Settlement Reference,payment_reference,bank_account,movement_type,gross_amount,status,value_date\nbnk-1,spc-1,demo-alfa-01,credit,\"10 000,50\",SETTLED,02/11/2026",
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rows[0]).toMatchObject({ settlementReference: "BNK-1", paymentReference: "SPC-1", grossAmountMinor: 1_000_050, netAmountMinor: 1_000_050, valueDate: "2026-11-02" });
    }
  });

  it("rejects files with missing columns or invalid rows, reporting row numbers", () => {
    expect(mapRows(parseCsv("foo,bar\n1,2"))).toMatchObject({ ok: false });
    const r = mapRows(parseCsv("settlement_reference,gross_amount,value_date\nBNK-1,-5,2026-11-02\nBNK-2,10,nope"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.row)).toEqual([2, 3]);
  });
});
