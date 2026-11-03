import { describe, expect, it } from "vitest";
import { summarizeAllocations } from "@/lib/kit/allocation";
import { canCloseFinancial, canCloseOperational, deriveStages, overallLabel, type LifecycleFacts } from "@/lib/lifecycle/stages";

const T = new Date("2026-11-02T10:00:00Z");

function facts(over: Partial<LifecycleFacts> = {}): LifecycleFacts {
  return {
    payment: { status: "successful", createdAt: T, confirmedAt: T, reversedAt: null },
    settlement: { lines: 0, firstAt: null, awaitingReconciliation: false },
    reconciliation: { state: "unreconciled", at: null },
    allocations: { ...summarizeAllocations(["pending", "pending"]), lastAt: null },
    operationalClosure: null,
    commission: { entries: 1, accruedMinor: 5_000, accruedAt: T, netMinor: 5_000, reversed: false, invoicedEntries: 0, invoicedAt: null, paidEntries: 0, partiallyPaid: false, collectedAt: null },
    financialClosure: null,
    ...over,
  };
}

const states = (f: LifecycleFacts) => Object.fromEntries(deriveStages(f).map((s) => [s.key, s.state]));

describe("lifecycle stages", () => {
  it("a freshly confirmed payment waits for settlement; commission is already accrued", () => {
    expect(states(facts())).toMatchObject({
      payment_confirmed: "done",
      bank_settlement: "current",
      reconciliation: "pending",
      kit_allocation: "pending",
      operational_closure: "pending",
      commission_accrued: "done",
      commission_invoiced: "current",
      commission_collected: "pending",
      financial_closure: "pending",
    });
  });

  it("settlement received is not reconciliation", () => {
    const f = facts({ settlement: { lines: 1, firstAt: T, awaitingReconciliation: true } });
    expect(states(f)).toMatchObject({ bank_settlement: "done", reconciliation: "current" });
  });

  it("partial KIT allocation keeps the transaction open", () => {
    const f = facts({
      settlement: { lines: 1, firstAt: T, awaitingReconciliation: false },
      reconciliation: { state: "reconciled", at: T },
      allocations: { ...summarizeAllocations(["allocated", "pending"]), lastAt: T },
    });
    expect(states(f)).toMatchObject({ reconciliation: "done", kit_allocation: "current", operational_closure: "pending" });
    expect(canCloseOperational(f)).toEqual({ ok: false, reasons: ["Faltam alocar 1 de 2 notas de débito no KIT."] });
  });

  it("the insurer can close operationally before SmartPay receives the commission", () => {
    const f = facts({
      settlement: { lines: 1, firstAt: T, awaitingReconciliation: false },
      reconciliation: { state: "reconciled", at: T },
      allocations: { ...summarizeAllocations(["allocated", "allocated"]), lastAt: T },
    });
    expect(canCloseOperational(f).ok).toBe(true);
    expect(canCloseFinancial(f).ok).toBe(false);
    const closed = { ...f, operationalClosure: { closedAt: T } };
    expect(states(closed)).toMatchObject({ operational_closure: "done", commission_collected: "pending", financial_closure: "pending" });
    expect(overallLabel(deriveStages(closed)).insurer).toBe("Encerrada");
  });

  it("SmartPay can close financially once the commission invoice is paid, independently of the insurer", () => {
    const f = facts({ commission: { ...facts().commission, invoicedEntries: 1, invoicedAt: T, paidEntries: 1, collectedAt: T } });
    expect(states(f)).toMatchObject({ commission_invoiced: "done", commission_collected: "done", financial_closure: "current", operational_closure: "pending" });
    expect(canCloseFinancial(f).ok).toBe(true);
  });

  it("accrual is not collection: an invoiced but unpaid commission blocks financial closure", () => {
    const f = facts({ commission: { ...facts().commission, invoicedEntries: 1, invoicedAt: T } });
    expect(canCloseFinancial(f).reasons).toEqual(["A factura da comissão ainda não está totalmente recebida."]);
    expect(states(f).commission_collected).toBe("current");
  });

  it("reversed payment: allocations must be voided in KIT; a cancelled-out commission can close", () => {
    const f = facts({
      payment: { status: "reversed", createdAt: T, confirmedAt: T, reversedAt: T },
      allocations: { ...summarizeAllocations(["allocated", "voided"]), lastAt: T },
      commission: { ...facts().commission, entries: 2, netMinor: 0, reversed: true },
    });
    expect(canCloseOperational(f).ok).toBe(false);
    expect(states(f)).toMatchObject({ payment_confirmed: "attention", kit_allocation: "attention", commission_invoiced: "skipped" });
    expect(canCloseFinancial(f).ok).toBe(true);
    const voided = { ...f, allocations: { ...summarizeAllocations(["voided", "voided"]), lastAt: T } };
    expect(canCloseOperational(voided).ok).toBe(true);
  });

  it("failed payments skip every downstream stage", () => {
    const f = facts({ payment: { status: "failed", createdAt: T, confirmedAt: null, reversedAt: null }, commission: { ...facts().commission, entries: 0, accruedAt: null } });
    const s = deriveStages(f);
    expect(s[0]!.state).toBe("attention");
    expect(s.slice(1).every((x) => x.state === "skipped")).toBe(true);
    expect(canCloseOperational(f).ok).toBe(false);
  });

  it("returns nine stages split between the insurer and SmartPay", () => {
    const s = deriveStages(facts());
    expect(s).toHaveLength(9);
    expect(s.filter((x) => x.side === "insurer")).toHaveLength(5);
  });
});
