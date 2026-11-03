/**
 * Payment state machine — the single source of truth for allowed transitions.
 * Mirrored in the database trigger `smartpay_check_payment_transition`.
 *
 *   created ──► pending ──► successful ──► reversed
 *      │           ├──────► failed
 *      │           └──────► cancelled
 *      ├──────────────────► successful / failed / cancelled
 */
export const PAYMENT_STATUSES = ["created", "pending", "successful", "failed", "cancelled", "reversed"] as const;
export type PaymentStatusValue = (typeof PAYMENT_STATUSES)[number];

const TRANSITIONS: Record<PaymentStatusValue, readonly PaymentStatusValue[]> = {
  created: ["pending", "successful", "failed", "cancelled"],
  pending: ["successful", "failed", "cancelled"],
  successful: ["reversed"],
  failed: [],
  cancelled: [],
  reversed: [],
};

export const TERMINAL_STATUSES: readonly PaymentStatusValue[] = ["failed", "cancelled", "reversed"];

export function canTransition(from: PaymentStatusValue, to: PaymentStatusValue): boolean {
  return TRANSITIONS[from].includes(to);
}

export type TransitionDecision =
  | { kind: "apply"; from: PaymentStatusValue; to: PaymentStatusValue }
  | { kind: "noop"; reason: "already_in_state" }
  | { kind: "reject"; reason: "invalid_transition"; from: PaymentStatusValue; to: PaymentStatusValue };

/**
 * Decides what to do with an incoming status. Re-delivery of the current state is a
 * harmless no-op (retry-safe webhooks); anything else outside the graph is rejected.
 */
export function decideTransition(from: PaymentStatusValue, to: PaymentStatusValue): TransitionDecision {
  if (from === to) return { kind: "noop", reason: "already_in_state" };
  if (canTransition(from, to)) return { kind: "apply", from, to };
  return { kind: "reject", reason: "invalid_transition", from, to };
}

export function isTerminal(status: PaymentStatusValue): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Commission eligibility: only successful payments accrue commission. */
export function isCommissionEligible(status: PaymentStatusValue): boolean {
  return status === "successful";
}
