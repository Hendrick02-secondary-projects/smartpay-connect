/**
 * KIT allocation rules — PURE (no I/O). One allocation per Debit Note.
 * Mirrored by the database trigger `smartpay_check_kit_allocation` (drizzle/0001).
 *
 *   pending ──allocate──► allocated ──reset──► pending
 *      │  ▲                   │
 *   flag_issue  reset/allocate│
 *      ▼  │                   │
 *    issue ───allocate────────┘
 *   (any) ──void──► voided      only when the PAYMENT was reversed (KIT allocation annulled)
 */

export const KIT_STATUSES = ["pending", "allocated", "issue", "voided"] as const;
export type KitStatus = (typeof KIT_STATUSES)[number];
export type KitAction = "allocate" | "flag_issue" | "reset" | "void";

export const KIT_STATUS_LABELS: Record<KitStatus, string> = {
  pending: "Por alocar",
  allocated: "Alocada",
  issue: "Com problema",
  voided: "Anulada",
};

export const KIT_ACTION_LABELS: Record<KitAction, string> = {
  allocate: "Marcar como alocada",
  flag_issue: "Assinalar problema",
  reset: "Anular alocação",
  void: "Anular no KIT (reversão)",
};

export interface AllocationContext {
  paymentStatus: "created" | "pending" | "successful" | "failed" | "cancelled" | "reversed";
  reconciliationStatus: "unreconciled" | "reconciled" | "exception" | "manually_reconciled";
  operationallyClosed: boolean;
  /** Payment date in Africa/Maputo (YYYY-MM-DD) — a KIT receipt cannot predate the payment. */
  paymentDate: string;
  /** Today in Africa/Maputo (YYYY-MM-DD). */
  today: string;
}

export interface AllocationInput {
  receiptReference?: string | null;
  allocatedOn?: string | null;
  notes?: string | null;
}

export type AllocationError =
  | "operationally_closed"
  | "invalid_transition"
  | "payment_not_successful"
  | "payment_not_reconciled"
  | "payment_not_reversed"
  | "receipt_required"
  | "invalid_receipt"
  | "date_required"
  | "invalid_date"
  | "date_in_future"
  | "date_before_payment"
  | "notes_required"
  | "notes_too_long";

export const ALLOCATION_ERROR_MESSAGES: Record<AllocationError, string> = {
  operationally_closed: "A transacção está encerrada operacionalmente. Reabra-a antes de alterar alocações.",
  invalid_transition: "Esta acção não é permitida no estado actual da nota de débito.",
  payment_not_successful: "O pagamento não está confirmado.",
  payment_not_reconciled: "Só é possível alocar no KIT depois de o pagamento estar reconciliado com o banco.",
  payment_not_reversed: "A anulação no KIT só se aplica a pagamentos revertidos.",
  receipt_required: "Indique a referência do recibo emitido no KIT.",
  invalid_receipt: "Referência de recibo inválida (3–40 caracteres: letras, dígitos, - / .).",
  date_required: "Indique a data da alocação no KIT.",
  invalid_date: "Data inválida.",
  date_in_future: "A data da alocação não pode ser futura.",
  date_before_payment: "A data da alocação não pode ser anterior ao pagamento.",
  notes_required: "Indique o motivo ou observação (mín. 10 caracteres).",
  notes_too_long: "Observações demasiado longas (máx. 500 caracteres).",
};

export const RECEIPT_PATTERN = /^[A-Z0-9][A-Z0-9\-/.]{2,39}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeReceipt(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}

function isRealDate(d: string): boolean {
  if (!DATE_PATTERN.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

const TRANSITIONS: Record<KitAction, readonly KitStatus[]> = {
  allocate: ["pending", "issue"],
  flag_issue: ["pending"],
  reset: ["allocated", "issue"],
  void: ["pending", "issue", "allocated"],
};

const TARGET: Record<KitAction, KitStatus> = { allocate: "allocated", flag_issue: "issue", reset: "pending", void: "voided" };

export type AllocationDecision =
  | { ok: true; next: KitStatus; receiptReference: string | null; allocatedOn: string | null; notes: string | null }
  | { ok: false; error: AllocationError };

export function decideAllocation(current: KitStatus, action: KitAction, ctx: AllocationContext, input: AllocationInput): AllocationDecision {
  const fail = (error: AllocationError): AllocationDecision => ({ ok: false, error });
  if (ctx.operationallyClosed) return fail("operationally_closed");
  if (!TRANSITIONS[action].includes(current)) return fail("invalid_transition");

  const notes = input.notes?.trim() || null;
  if (notes && notes.length > 500) return fail("notes_too_long");

  if (action === "void") {
    if (ctx.paymentStatus !== "reversed") return fail("payment_not_reversed");
    if (!notes || notes.length < 10) return fail("notes_required");
    const receipt = input.receiptReference ? normalizeReceipt(input.receiptReference) : null;
    if (receipt && !RECEIPT_PATTERN.test(receipt)) return fail("invalid_receipt");
    return { ok: true, next: "voided", receiptReference: receipt, allocatedOn: null, notes };
  }

  if (ctx.paymentStatus !== "successful") return fail("payment_not_successful");

  if (action === "allocate") {
    if (ctx.reconciliationStatus !== "reconciled" && ctx.reconciliationStatus !== "manually_reconciled") return fail("payment_not_reconciled");
    if (!input.receiptReference?.trim()) return fail("receipt_required");
    const receipt = normalizeReceipt(input.receiptReference);
    if (!RECEIPT_PATTERN.test(receipt)) return fail("invalid_receipt");
    if (!input.allocatedOn) return fail("date_required");
    if (!isRealDate(input.allocatedOn)) return fail("invalid_date");
    if (input.allocatedOn > ctx.today) return fail("date_in_future");
    if (input.allocatedOn < ctx.paymentDate) return fail("date_before_payment");
    return { ok: true, next: "allocated", receiptReference: receipt, allocatedOn: input.allocatedOn, notes };
  }

  // flag_issue / reset both require a written reason
  if (!notes || notes.length < 10) return fail("notes_required");
  return { ok: true, next: TARGET[action], receiptReference: null, allocatedOn: null, notes };
}

export interface AllocationSummary {
  total: number;
  allocated: number;
  pending: number;
  issue: number;
  voided: number;
  /** none: no notes yet · complete: all allocated · voided: all annulled · attention: any issue · partial · pending */
  state: "none" | "pending" | "partial" | "complete" | "voided" | "attention";
}

export function summarizeAllocations(statuses: readonly KitStatus[]): AllocationSummary {
  const s = { total: statuses.length, allocated: 0, pending: 0, issue: 0, voided: 0 };
  for (const st of statuses) s[st]++;
  let state: AllocationSummary["state"];
  if (s.total === 0) state = "none";
  else if (s.voided === s.total) state = "voided";
  else if (s.issue > 0) state = "attention";
  else if (s.allocated === s.total) state = "complete";
  else if (s.allocated > 0) state = "partial";
  else state = "pending";
  return { ...s, state };
}
