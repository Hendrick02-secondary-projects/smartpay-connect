import { describe, expect, it } from "vitest";
import { matchSettlementLines, summarize, type PaymentSnapshot, type SettlementLine } from "@/lib/reconciliation/matcher";
import { buildSettlementLines, settlementTotals } from "@/lib/settlement/scenarios";

const payments = new Map<string, PaymentSnapshot>([
  ["SPC-A", { id: "a", reference: "SPC-A", amountMinor: 1_000_000, bankAccountCode: "DEMO-ALFA-01", status: "successful", alreadyReconciled: false }],
  ["SPC-B", { id: "b", reference: "SPC-B", amountMinor: 250_000, bankAccountCode: "DEMO-BETA-02", status: "successful", alreadyReconciled: false }],
  ["SPC-C", { id: "c", reference: "SPC-C", amountMinor: 80_000, bankAccountCode: "DEMO-ALFA-01", status: "failed", alreadyReconciled: false }],
  ["SPC-D", { id: "d", reference: "SPC-D", amountMinor: 50_000, bankAccountCode: "DEMO-ALFA-01", status: "successful", alreadyReconciled: true }],
  ["SPC-E", { id: "e", reference: "SPC-E", amountMinor: 70_000, bankAccountCode: "DEMO-ALFA-01", status: "pending", alreadyReconciled: false }],
  ["SPC-R", { id: "r", reference: "SPC-R", amountMinor: 90_000, bankAccountCode: "DEMO-ALFA-01", status: "reversed", alreadyReconciled: true }],
]);

const line = (n: number, over: Partial<SettlementLine>): SettlementLine => ({
  rowNumber: n,
  settlementReference: `STL-${n}`,
  paymentReference: null,
  bankAccountCode: null,
  movementType: "credit",
  grossAmountMinor: 0,
  reportedStatus: "SETTLED",
  ...over,
});

describe("reconciliation matcher", () => {
  it("matches only when reference, amount, account and status agree", () => {
    const [r] = matchSettlementLines(
      [line(1, { paymentReference: "spc-a", bankAccountCode: "DEMO-ALFA-01", grossAmountMinor: 1_000_000 })],
      payments,
      new Set(),
    );
    expect(r).toMatchObject({ status: "matched", reasonCode: "MATCHED", paymentId: "a", differenceMinor: 0 });
  });

  it("classifies every exception type", () => {
    const results = matchSettlementLines(
      [
        line(1, { paymentReference: "SPC-B", grossAmountMinor: 240_000 }), // amount mismatch
        line(2, { paymentReference: "SPC-ZZZ", grossAmountMinor: 1 }), // unknown
        line(3, { paymentReference: "SPC-C", grossAmountMinor: 80_000 }), // not successful
        line(4, { paymentReference: "SPC-D", grossAmountMinor: 50_000 }), // payment already settled
        line(5, { paymentReference: "SPC-E", grossAmountMinor: 70_000 }), // still pending -> review
        line(6, { paymentReference: "SPC-A", grossAmountMinor: 1_000_000, bankAccountCode: "DEMO-XXX" }), // account mismatch
        line(7, { paymentReference: null, grossAmountMinor: 10 }), // missing ref
        line(8, { settlementReference: "STL-OLD", paymentReference: "SPC-A", grossAmountMinor: 1_000_000 }), // dup ref (DB)
      ],
      payments,
      new Set(["STL-OLD"]),
    );
    expect(results.map((r) => [r.status, r.reasonCode])).toEqual([
      ["amount_mismatch", "AMOUNT_MISMATCH"],
      ["unmatched", "UNKNOWN_PAYMENT_REFERENCE"],
      ["unmatched", "PAYMENT_NOT_SUCCESSFUL"],
      ["duplicate_settlement", "PAYMENT_ALREADY_SETTLED"],
      ["under_review", "PAYMENT_STILL_PENDING"],
      ["under_review", "ACCOUNT_MISMATCH"],
      ["unmatched", "MISSING_PAYMENT_REFERENCE"],
      ["duplicate_settlement", "DUPLICATE_SETTLEMENT_REFERENCE"],
    ]);
    expect(results[0]!.differenceMinor).toBe(-10_000);
    expect(results[7]!.isDuplicateRow).toBe(true);
    expect(summarize(results).counts.matched).toBe(0);
  });

  it("detects duplicates within the same file", () => {
    const results = matchSettlementLines(
      [
        line(1, { paymentReference: "SPC-A", grossAmountMinor: 1_000_000 }),
        line(2, { settlementReference: "STL-1", paymentReference: "SPC-A", grossAmountMinor: 1_000_000 }),
        line(3, { settlementReference: "STL-X", paymentReference: "SPC-A", grossAmountMinor: 1_000_000 }),
      ],
      payments,
      new Set(),
    );
    expect(results.map((r) => r.status)).toEqual(["matched", "duplicate_settlement", "duplicate_settlement"]);
    expect(results.map((r) => r.reasonCode)).toEqual(["MATCHED", "DUPLICATE_SETTLEMENT_REFERENCE", "PAYMENT_ALREADY_SETTLED"]);
  });

  it("does not reconcile a payment just because it succeeded (no line, no match)", () => {
    expect(matchSettlementLines([], payments, new Set())).toEqual([]);
  });

  it("confirms reversal debits only for reversed payments", () => {
    const results = matchSettlementLines(
      [
        line(1, { movementType: "reversal_debit", paymentReference: "SPC-R", grossAmountMinor: 90_000 }),
        line(2, { movementType: "reversal_debit", paymentReference: "SPC-B", grossAmountMinor: 250_000 }),
        line(3, { movementType: "fee_debit", grossAmountMinor: 5_000 }),
      ],
      payments,
      new Set(),
    );
    expect(results.map((r) => r.reasonCode)).toEqual(["REVERSAL_CONFIRMED", "REVERSAL_FOR_NON_REVERSED_PAYMENT", "FEE_MOVEMENT_IDENTIFIED"]);
  });
});

describe("simulated settlement scenarios", () => {
  const ps = [
    { reference: "SPC-A", amountMinor: 1_000_000, method: "card" as const, bankAccountCode: "DEMO-ALFA-01", commissionMinor: 5_000 },
    { reference: "SPC-B", amountMinor: 200_000, method: "mpesa" as const, bankAccountCode: "DEMO-BETA-02", commissionMinor: 1_000 },
  ];
  it("gross: the insurer receives gross; fees recorded separately", () => {
    const lines = buildSettlementLines("gross", "SB1", ps);
    expect(settlementTotals(lines)).toMatchObject({ gross: 1_200_000, gatewayFees: 27_000, platformFees: 6_000, net: 1_200_000, deducted: 0 });
  });
  it("net: gateway fee and SmartPay commission deducted before credit", () => {
    const lines = buildSettlementLines("net", "SB1", ps);
    expect(lines[0]!.netAmountMinor).toBe(1_000_000 - 25_000 - 5_000);
    expect(settlementTotals(lines).net).toBe(1_200_000 - 27_000 - 6_000);
  });
  it("separate fee debit (V1.1): two distinct debits — gateway fee and SmartPay commission", () => {
    const lines = buildSettlementLines("separate_fee_debit", "SB1", ps);
    expect(lines).toHaveLength(4);
    expect(lines[2]).toMatchObject({ movementType: "fee_debit", feeKind: "gateway", grossAmountMinor: 27_000, netAmountMinor: -27_000 });
    expect(lines[3]).toMatchObject({ movementType: "fee_debit", feeKind: "platform", grossAmountMinor: 6_000, netAmountMinor: -6_000 });
    expect(settlementTotals(lines)).toMatchObject({ gross: 1_200_000, net: 1_200_000 - 33_000, debitedGateway: 27_000, debitedPlatform: 6_000 });
  });
});
