import { describe, expect, it } from "vitest";
import { matchSettlementLines, type PaymentSnapshot, type SettlementLine } from "@/lib/reconciliation/matcher";
import { mapRows, parseCsv } from "@/lib/reconciliation/parser";
import { buildSettlementLines, settlementTotals } from "@/lib/settlement/scenarios";

const payments = new Map<string, PaymentSnapshot>([
  ["SPC-A", { id: "a", reference: "SPC-A", amountMinor: 1_000_000, bankAccountCode: "DEMO-ALFA-01", status: "successful", alreadyReconciled: false }],
  ["SPC-B", { id: "b", reference: "SPC-B", amountMinor: 250_000, bankAccountCode: "DEMO-ALFA-01", status: "successful", alreadyReconciled: false }],
  ["SPC-C", { id: "c", reference: "SPC-C", amountMinor: 80_000, bankAccountCode: "DEMO-ALFA-01", status: "successful", alreadyReconciled: false }],
]);
const ps = [
  { reference: "SPC-A", amountMinor: 1_000_000, method: "card" as const, bankAccountCode: "DEMO-ALFA-01", commissionMinor: 5_000 },
  { reference: "SPC-B", amountMinor: 250_000, method: "mpesa" as const, bankAccountCode: "DEMO-ALFA-01", commissionMinor: 1_250 },
  { reference: "SPC-C", amountMinor: 80_000, method: "emola" as const, bankAccountCode: "DEMO-ALFA-01", commissionMinor: 400 },
];
const toLines = (gen: ReturnType<typeof buildSettlementLines>): SettlementLine[] => gen.map((l, i) => ({ ...l, rowNumber: i + 1 }));

describe("aggregated settlement (V1.1)", () => {
  it("produces ONE bank credit plus one detail line per payment", () => {
    const lines = buildSettlementLines("aggregated", "SB9", ps);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({ lineKind: "statement", paymentReference: null, grossAmountMinor: 1_330_000, netAmountMinor: 1_330_000 });
    expect(lines.slice(1).every((l) => l.lineKind === "detail" && l.parentReference === "SB9-AGG")).toBe(true);
    // one bank movement; fees attributed per payment, not double counted
    expect(settlementTotals(lines)).toMatchObject({ bankMovements: 1, gross: 1_330_000, net: 1_330_000, gatewayFees: 25_000 + 2_500 + 800, platformFees: 6_650 });
  });

  it("reconciles every payment when the aggregate balances", () => {
    const r = matchSettlementLines(toLines(buildSettlementLines("aggregated", "SB9", ps)), payments, new Set());
    expect(r.map((x) => x.reasonCode)).toEqual(["AGGREGATE_BALANCED", "MATCHED", "MATCHED", "MATCHED"]);
    expect(r[0]).toMatchObject({ status: "matched", expectedAmountMinor: 1_330_000, differenceMinor: 0 });
  });

  it("holds every payment for review when the aggregate does not balance", () => {
    const lines = toLines(buildSettlementLines("aggregated", "SB9", ps));
    lines[0] = { ...lines[0]!, grossAmountMinor: 1_329_000 }; // bank credited 10 MZN less
    const r = matchSettlementLines(lines, payments, new Set());
    expect(r[0]).toMatchObject({ status: "under_review", reasonCode: "AGGREGATE_UNBALANCED", differenceMinor: -1_000 });
    expect(r.slice(1).map((x) => x.reasonCode)).toEqual(["DETAIL_IN_UNBALANCED_AGGREGATE", "DETAIL_IN_UNBALANCED_AGGREGATE", "DETAIL_IN_UNBALANCED_AGGREGATE"]);
  });

  it("a mismatched detail line also unbalances the aggregate", () => {
    const lines = toLines(buildSettlementLines("aggregated", "SB9", ps));
    lines[2] = { ...lines[2]!, grossAmountMinor: 240_000 };
    lines[0] = { ...lines[0]!, grossAmountMinor: 1_320_000 }; // sums still agree, but B's detail is wrong
    const r = matchSettlementLines(lines, payments, new Set());
    expect(r[0]!.reasonCode).toBe("AGGREGATE_UNBALANCED");
    expect(r[2]!.reasonCode).toBe("AMOUNT_MISMATCH");
    expect(r[1]!.reasonCode).toBe("DETAIL_IN_UNBALANCED_AGGREGATE");
  });

  it("flags detail lines without their aggregate", () => {
    const orphan: SettlementLine = { rowNumber: 1, settlementReference: "X-D1", paymentReference: "SPC-A", bankAccountCode: null, movementType: "credit", grossAmountMinor: 1_000_000, reportedStatus: null, lineKind: "detail", parentReference: "NOPE" };
    expect(matchSettlementLines([orphan], payments, new Set())[0]!.reasonCode).toBe("ORPHAN_DETAIL_LINE");
  });

  it("checks net arithmetic: net must be gross or gross − gateway fee − commission", () => {
    const net = toLines(buildSettlementLines("net", "SB8", ps.slice(0, 1)));
    expect(matchSettlementLines(net, payments, new Set())[0]!.reasonCode).toBe("MATCHED");
    const broken = [{ ...net[0]!, netAmountMinor: 900_000 }];
    expect(matchSettlementLines(broken, payments, new Set())[0]!.reasonCode).toBe("NET_ARITHMETIC_MISMATCH");
  });

  it("separates gateway fees, SmartPay commission and bank movements per scenario", () => {
    expect(settlementTotals(buildSettlementLines("gross", "G", ps))).toMatchObject({ net: 1_330_000, deducted: 0, debitedGateway: 0, debitedPlatform: 0 });
    expect(settlementTotals(buildSettlementLines("net", "N", ps))).toMatchObject({ net: 1_330_000 - 28_300 - 6_650, deducted: 28_300 + 6_650 });
    expect(settlementTotals(buildSettlementLines("separate_fee_debit", "S", ps))).toMatchObject({ net: 1_330_000 - 28_300 - 6_650, debitedGateway: 28_300, debitedPlatform: 6_650, bankMovements: 5 });
  });

  it("parses aggregated files with the optional V1.1 columns", () => {
    const csv =
      "settlement_reference,payment_reference,movement_type,gross_amount,value_date,line_kind,parent_reference\n" +
      "BNK-AGG-1,,credit,12500,2026-11-02,statement,\n" +
      "BNK-AGG-1-D1,SPC-A,credit,10000,2026-11-02,detail,BNK-AGG-1\n" +
      "BNK-AGG-1-D2,SPC-B,credit,2500,2026-11-02,detail,BNK-AGG-1\n";
    const r = mapRows(parseCsv(csv));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows.map((x) => x.lineKind)).toEqual(["statement", "detail", "detail"]);
    const m = matchSettlementLines(r.rows, payments, new Set());
    expect(m.map((x) => x.reasonCode)).toEqual(["AGGREGATE_BALANCED", "MATCHED", "MATCHED"]);
    expect(mapRows(parseCsv("settlement_reference,gross_amount,value_date,line_kind\nX-1,10,2026-11-02,detail"))).toMatchObject({ ok: false });
  });
});
