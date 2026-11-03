import { describe, expect, it } from "vitest";
import {
  debitNotesTotal,
  generatePaymentReference,
  isValidCustomerName,
  normalizeCustomerName,
  normalizeMozPhone,
  validateDebitNotes,
} from "@/lib/payments/rules";
import { canTransition, decideTransition, isCommissionEligible } from "@/lib/payments/state-machine";

describe("customer validation", () => {
  it("normalises Mozambican mobile numbers", () => {
    expect(normalizeMozPhone("84 123 4567")).toBe("+258841234567");
    expect(normalizeMozPhone("+258 86 000 0001")).toBe("+258860000001");
    expect(normalizeMozPhone("00258870000002")).toBe("+258870000002");
    expect(normalizeMozPhone("81 123 4567")).toBeNull(); // 81 is not a mobile prefix
    expect(normalizeMozPhone("8412345")).toBeNull();
    expect(normalizeMozPhone("abc")).toBeNull();
  });
  it("requires a meaningful customer name", () => {
    expect(isValidCustomerName(normalizeCustomerName("  Ana   Machava "))).toBe(true);
    expect(isValidCustomerName("Jo")).toBe(false);
    expect(isValidCustomerName("123")).toBe(false);
    expect(isValidCustomerName("<script>")).toBe(false);
  });
});

describe("debit notes", () => {
  it("accepts multiple valid notes and totals them exactly", () => {
    const notes = [
      { number: "DN-2026-0001", amountMinor: 650_000 },
      { number: "dn-2026-0002", amountMinor: 350_000 },
    ];
    expect(validateDebitNotes(notes).code).toBe("none");
    expect(debitNotesTotal(notes)).toBe(1_000_000);
  });
  it("requires at least one note", () => {
    expect(validateDebitNotes([]).code).toBe("empty");
  });
  it("rejects non-positive amounts", () => {
    expect(validateDebitNotes([{ number: "DN-1001", amountMinor: 0 }])).toEqual({ code: "non_positive_amount", index: 0 });
    expect(validateDebitNotes([{ number: "DN-1001", amountMinor: -10 }]).code).toBe("non_positive_amount");
  });
  it("rejects repeated debit notes in the same payment (case/space-insensitive)", () => {
    const r = validateDebitNotes([
      { number: "DN-1001", amountMinor: 100 },
      { number: " dn-1001 ", amountMinor: 200 },
    ]);
    expect(r).toEqual({ code: "duplicate_number", index: 1 });
  });
  it("rejects malformed note numbers", () => {
    expect(validateDebitNotes([{ number: "#", amountMinor: 100 }]).code).toBe("invalid_number");
  });
});

describe("payment reference", () => {
  it("is deterministic for given randomness and well-formed", () => {
    const ref = generatePaymentReference("SPC", new Date("2026-11-02T10:00:00Z"), new Uint8Array([0, 1, 2, 3, 4, 5, 6, 31]));
    expect(ref).toBe("SPC-261102-0123456Z");
  });
});

describe("payment state machine", () => {
  it("allows the documented happy paths", () => {
    expect(canTransition("created", "pending")).toBe(true);
    expect(canTransition("pending", "successful")).toBe(true);
    expect(canTransition("successful", "reversed")).toBe(true);
  });
  it("blocks illegal transitions", () => {
    expect(canTransition("failed", "successful")).toBe(false);
    expect(canTransition("reversed", "successful")).toBe(false);
    expect(canTransition("cancelled", "pending")).toBe(false);
    expect(canTransition("successful", "failed")).toBe(false);
    expect(decideTransition("failed", "successful").kind).toBe("reject");
  });
  it("treats re-delivered states as idempotent no-ops", () => {
    expect(decideTransition("successful", "successful")).toEqual({ kind: "noop", reason: "already_in_state" });
  });
  it("only successful payments are commission-eligible", () => {
    expect(isCommissionEligible("successful")).toBe(true);
    expect(isCommissionEligible("pending")).toBe(false);
  });
});
