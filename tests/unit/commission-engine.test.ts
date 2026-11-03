import { describe, expect, it } from "vitest";
import {
  computeAccrual,
  computeReversalAmount,
  deriveLifecycle,
  invoiceStatusFor,
  netForPayment,
  selectApplicableRule,
  validateNewRule,
  type RuleLike,
} from "@/lib/commission/engine";

const v1: RuleLike = {
  id: "r1",
  version: 1,
  ratePpm: 5_000,
  effectiveFrom: new Date("2026-01-01T00:00:00Z"),
  effectiveTo: new Date("2026-10-01T00:00:00Z"),
  status: "superseded",
};
const v2: RuleLike = {
  id: "r2",
  version: 2,
  ratePpm: 7_500,
  effectiveFrom: new Date("2026-10-01T00:00:00Z"),
  effectiveTo: null,
  status: "active",
};
const draft: RuleLike = { ...v2, id: "r3", version: 3, ratePpm: 1, status: "draft", effectiveFrom: new Date("2026-10-15T00:00:00Z") };

describe("commission calculation", () => {
  it("10,000 MZN at 0.5% accrues exactly 50 MZN", () => {
    const acc = computeAccrual(1_000_000, v1);
    expect(acc).toEqual({ ruleId: "r1", ruleVersion: 1, ratePpm: 5_000, baseAmountMinor: 1_000_000, amountMinor: 5_000 });
  });
});

describe("rule versioning", () => {
  it("selects the rule in force at the eligibility instant", () => {
    expect(selectApplicableRule([v1, v2], new Date("2026-09-30T23:59:59Z"))?.id).toBe("r1");
    expect(selectApplicableRule([v1, v2], new Date("2026-10-01T00:00:00Z"))?.id).toBe("r2");
    expect(selectApplicableRule([v1, v2], new Date("2025-12-31T00:00:00Z"))).toBeNull();
  });
  it("ignores drafts", () => {
    expect(selectApplicableRule([v1, v2, draft], new Date("2026-11-01T00:00:00Z"))?.id).toBe("r2");
  });
  it("does not re-price history: an old payment keeps its snapshot", () => {
    const oldSnapshot = computeAccrual(1_000_000, selectApplicableRule([v1, v2], new Date("2026-05-01Z"))!);
    const newSnapshot = computeAccrual(1_000_000, selectApplicableRule([v1, v2], new Date("2026-11-01Z"))!);
    expect(oldSnapshot.amountMinor).toBe(5_000);
    expect(newSnapshot.amountMinor).toBe(7_500);
  });
  it("validates new rule versions", () => {
    const now = new Date("2026-11-02T12:00:00Z");
    expect(validateNewRule([v1, v2], { ratePpm: 6_000, effectiveFrom: new Date("2026-11-03Z"), effectiveTo: null }, now)).toBeNull();
    expect(validateNewRule([v1, v2], { ratePpm: 6_000, effectiveFrom: new Date("2026-10-15Z"), effectiveTo: null }, now)).toBe("starts_in_past");
    expect(validateNewRule([v1, v2], { ratePpm: 200_000, effectiveFrom: new Date("2026-11-03Z"), effectiveTo: null }, now)).toBe("rate_out_of_range");
    expect(
      validateNewRule([v1, v2], { ratePpm: 6_000, effectiveFrom: new Date("2026-11-05Z"), effectiveTo: new Date("2026-11-04Z") }, now),
    ).toBe("invalid_window");
  });
});

describe("reversals and compensating entries", () => {
  it("reverses exactly what was booked (accrual + adjustments)", () => {
    const entries = [
      { entryType: "accrual" as const, amountMinor: 5_000 },
      { entryType: "adjustment" as const, amountMinor: -1_000 },
    ];
    expect(computeReversalAmount(entries)).toBe(-4_000);
    expect(netForPayment([...entries, { entryType: "reversal", amountMinor: -4_000 }])).toBe(0);
  });
  it("refuses a second reversal", () => {
    expect(() =>
      computeReversalAmount([
        { entryType: "accrual", amountMinor: 5_000 },
        { entryType: "reversal", amountMinor: -5_000 },
      ]),
    ).toThrow();
  });
});

describe("lifecycle: accrual is not collection", () => {
  const accrual = [{ entryType: "accrual" as const, amountMinor: 5_000 }];
  it("stays 'accrued' until invoiced and collected", () => {
    expect(deriveLifecycle({ entries: accrual, invoiceStatus: null })).toBe("accrued");
    expect(deriveLifecycle({ entries: accrual, invoiceStatus: "issued" })).toBe("invoiced");
    expect(deriveLifecycle({ entries: accrual, invoiceStatus: "partially_paid" })).toBe("partially_paid");
    expect(deriveLifecycle({ entries: accrual, invoiceStatus: "paid" })).toBe("paid");
    expect(deriveLifecycle({ entries: [...accrual, { entryType: "reversal", amountMinor: -5_000 }], invoiceStatus: "paid" })).toBe("reversed");
  });
  it("derives invoice status from collections", () => {
    expect(invoiceStatusFor(5_000, 0)).toBe("issued");
    expect(invoiceStatusFor(5_000, 2_000)).toBe("partially_paid");
    expect(invoiceStatusFor(5_000, 5_000)).toBe("paid");
  });
});
