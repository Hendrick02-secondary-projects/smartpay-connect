/**
 * Commission engine — PURE functions (no I/O). The service layer
 * (src/lib/commission/service.ts) persists the results inside DB transactions.
 *
 *   commission = eligible_payment_amount × contracted_rate
 *
 * - amounts: integer minor units; rate: integer ppm; rounding: half-even.
 * - the rule in force at the moment the payment BECOMES ELIGIBLE (successful)
 *   is snapshotted onto the ledger entry. Later rule changes never touch it.
 */
import { applyRatePpm } from "@/lib/money";

export interface RuleLike {
  id: string;
  version: number;
  ratePpm: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  status: "active" | "superseded" | "expired" | "draft";
}

/**
 * Selects the rule applicable at instant `at`: effectiveFrom <= at < effectiveTo,
 * excluding drafts. If several overlap (should not happen), the highest version wins.
 * Superseded/expired rules remain selectable for their historical window — that is
 * what makes historical recalculation and audit possible.
 */
export function selectApplicableRule<T extends RuleLike>(rules: readonly T[], at: Date): T | null {
  const t = at.getTime();
  let best: T | null = null;
  for (const r of rules) {
    if (r.status === "draft") continue;
    if (r.effectiveFrom.getTime() > t) continue;
    if (r.effectiveTo && r.effectiveTo.getTime() <= t) continue;
    if (!best || r.version > best.version) best = r;
  }
  return best;
}

export interface AccrualComputation {
  ruleId: string;
  ruleVersion: number;
  ratePpm: number;
  baseAmountMinor: number;
  amountMinor: number;
}

export function computeAccrual(amountMinor: number, rule: RuleLike): AccrualComputation {
  return {
    ruleId: rule.id,
    ruleVersion: rule.version,
    ratePpm: rule.ratePpm,
    baseAmountMinor: amountMinor,
    amountMinor: applyRatePpm(amountMinor, rule.ratePpm),
  };
}

export interface LedgerEntryLike {
  entryType: "accrual" | "adjustment" | "reversal";
  amountMinor: number;
}

/** Net commission currently booked for a payment (accrual + adjustments + reversals). */
export function netForPayment(entries: readonly LedgerEntryLike[]): number {
  return entries.reduce((acc, e) => acc + e.amountMinor, 0);
}

/**
 * Reversal amount for a reversed payment: the exact negative of everything booked,
 * so the payment's net commission returns to zero. Returns 0 when nothing is booked.
 */
export function computeReversalAmount(entries: readonly LedgerEntryLike[]): number {
  if (entries.some((e) => e.entryType === "reversal")) {
    throw new Error("Commission for this payment has already been reversed");
  }
  const net = netForPayment(entries);
  return net === 0 ? 0 : -net;
}

/**
 * Validates the next version of a commission rule. Returns an error code or null.
 * New rules can only start in the future relative to `now` minus a small tolerance,
 * so already-accrued commissions cannot be retro-actively re-priced.
 */
export function validateNewRule(
  existing: readonly RuleLike[],
  next: { ratePpm: number; effectiveFrom: Date; effectiveTo: Date | null },
  now: Date,
): "rate_out_of_range" | "starts_in_past" | "invalid_window" | "before_current_rule" | null {
  if (!Number.isInteger(next.ratePpm) || next.ratePpm < 0 || next.ratePpm > 100_000) return "rate_out_of_range";
  if (next.effectiveFrom.getTime() < now.getTime() - 60_000) return "starts_in_past";
  if (next.effectiveTo && next.effectiveTo.getTime() <= next.effectiveFrom.getTime()) return "invalid_window";
  const latestStart = existing
    .filter((r) => r.status !== "draft")
    .reduce((max, r) => Math.max(max, r.effectiveFrom.getTime()), 0);
  if (next.effectiveFrom.getTime() <= latestStart) return "before_current_rule";
  return null;
}

export type CommissionLifecycle = "accrued" | "adjusted" | "invoiced" | "partially_paid" | "paid" | "reversed";

/**
 * Lifecycle of the commission attached to one payment, derived from immutable facts:
 * ledger entries + invoice state. Accrual is NOT collection: "paid" requires a
 * recorded collection against the invoice that contains the accrual.
 */
export function deriveLifecycle(input: {
  entries: readonly LedgerEntryLike[];
  invoiceStatus: "issued" | "partially_paid" | "paid" | "void" | null;
}): CommissionLifecycle {
  if (input.entries.some((e) => e.entryType === "reversal")) return "reversed";
  if (input.invoiceStatus === "paid") return "paid";
  if (input.invoiceStatus === "partially_paid") return "partially_paid";
  if (input.invoiceStatus === "issued") return "invoiced";
  if (input.entries.some((e) => e.entryType === "adjustment")) return "adjusted";
  return "accrued";
}

/** Invoice status from amounts collected so far. */
export function invoiceStatusFor(invoiceAmountMinor: number, collectedMinor: number): "issued" | "partially_paid" | "paid" {
  if (collectedMinor <= 0) return "issued";
  if (collectedMinor < invoiceAmountMinor) return "partially_paid";
  return "paid";
}
