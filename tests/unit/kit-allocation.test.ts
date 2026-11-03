import { describe, expect, it } from "vitest";
import { decideAllocation, summarizeAllocations, type AllocationContext } from "@/lib/kit/allocation";

const ctx = (over: Partial<AllocationContext> = {}): AllocationContext => ({
  paymentStatus: "successful",
  reconciliationStatus: "reconciled",
  operationallyClosed: false,
  paymentDate: "2026-11-01",
  today: "2026-11-03",
  ...over,
});
const ok = { receiptReference: " kit-rec 2026/0001 ", allocatedOn: "2026-11-02", notes: null };

describe("KIT allocation rules", () => {
  it("allocates a reconciled payment's debit note and normalises the receipt", () => {
    expect(decideAllocation("pending", "allocate", ctx(), ok)).toEqual({
      ok: true,
      next: "allocated",
      receiptReference: "KIT-REC2026/0001",
      allocatedOn: "2026-11-02",
      notes: null,
    });
  });

  it("requires bank reconciliation before allocation (manual reconciliation counts)", () => {
    expect(decideAllocation("pending", "allocate", ctx({ reconciliationStatus: "unreconciled" }), ok)).toEqual({ ok: false, error: "payment_not_reconciled" });
    expect(decideAllocation("pending", "allocate", ctx({ reconciliationStatus: "exception" }), ok)).toEqual({ ok: false, error: "payment_not_reconciled" });
    expect(decideAllocation("pending", "allocate", ctx({ reconciliationStatus: "manually_reconciled" }), ok).ok).toBe(true);
  });

  it("validates receipt and date", () => {
    expect(decideAllocation("pending", "allocate", ctx(), { ...ok, receiptReference: "" })).toEqual({ ok: false, error: "receipt_required" });
    expect(decideAllocation("pending", "allocate", ctx(), { ...ok, receiptReference: "#" })).toEqual({ ok: false, error: "invalid_receipt" });
    expect(decideAllocation("pending", "allocate", ctx(), { ...ok, allocatedOn: null })).toEqual({ ok: false, error: "date_required" });
    expect(decideAllocation("pending", "allocate", ctx(), { ...ok, allocatedOn: "2026-02-30" })).toEqual({ ok: false, error: "invalid_date" });
    expect(decideAllocation("pending", "allocate", ctx(), { ...ok, allocatedOn: "2026-11-04" })).toEqual({ ok: false, error: "date_in_future" });
    expect(decideAllocation("pending", "allocate", ctx(), { ...ok, allocatedOn: "2026-10-31" })).toEqual({ ok: false, error: "date_before_payment" });
  });

  it("enforces the state machine", () => {
    expect(decideAllocation("allocated", "allocate", ctx(), ok)).toEqual({ ok: false, error: "invalid_transition" });
    expect(decideAllocation("issue", "allocate", ctx(), ok).ok).toBe(true);
    expect(decideAllocation("allocated", "flag_issue", ctx(), { notes: "Recibo com valor errado" })).toEqual({ ok: false, error: "invalid_transition" });
    expect(decideAllocation("pending", "reset", ctx(), { notes: "Motivo suficiente" })).toEqual({ ok: false, error: "invalid_transition" });
    expect(decideAllocation("voided", "allocate", ctx(), ok)).toEqual({ ok: false, error: "invalid_transition" });
  });

  it("requires a written reason to flag, reset or void", () => {
    expect(decideAllocation("pending", "flag_issue", ctx(), { notes: "curto" })).toEqual({ ok: false, error: "notes_required" });
    expect(decideAllocation("pending", "flag_issue", ctx(), { notes: "ND não existe no KIT" })).toMatchObject({ ok: true, next: "issue" });
    expect(decideAllocation("allocated", "reset", ctx(), { notes: "Alocado à apólice errada" })).toMatchObject({ ok: true, next: "pending", receiptReference: null });
  });

  it("only voids allocations of reversed payments", () => {
    expect(decideAllocation("allocated", "void", ctx(), { notes: "Chargeback do titular" })).toEqual({ ok: false, error: "payment_not_reversed" });
    expect(decideAllocation("allocated", "void", ctx({ paymentStatus: "reversed" }), { notes: "Chargeback do titular", receiptReference: "kit-anul-1" })).toMatchObject({
      ok: true,
      next: "voided",
      receiptReference: "KIT-ANUL-1",
    });
  });

  it("blocks every change once the transaction is operationally closed", () => {
    expect(decideAllocation("pending", "allocate", ctx({ operationallyClosed: true }), ok)).toEqual({ ok: false, error: "operationally_closed" });
  });

  it("a transaction is fully allocated only when every debit note is allocated", () => {
    expect(summarizeAllocations([]).state).toBe("none");
    expect(summarizeAllocations(["pending", "pending"]).state).toBe("pending");
    expect(summarizeAllocations(["allocated", "pending"])).toMatchObject({ state: "partial", allocated: 1, total: 2 });
    expect(summarizeAllocations(["allocated", "issue"]).state).toBe("attention");
    expect(summarizeAllocations(["allocated", "allocated"]).state).toBe("complete");
    expect(summarizeAllocations(["voided", "voided"]).state).toBe("voided");
  });
});
