/**
 * Transaction lifecycle — PURE. Derives the nine stages from immutable facts
 * (payments, settlement lines, reconciliation, KIT allocations, ledger, invoices,
 * collections, closures). Nothing here is stored as a "stage status": the stages
 * are always recomputed, so they cannot drift from the underlying records.
 *
 *   Insurer (operational)                         SmartPay (financial)
 *   1 Pagamento confirmado                        6 Comissão apurada
 *   2 Liquidação bancária                         7 Comissão facturada
 *   3 Reconciliação                               8 Comissão recebida
 *   4 Alocação de Pagamentos                      9 Encerramento financeiro SmartPay
 *   5 Encerramento operacional da seguradora
 *
 * The two sides close independently: the insurer can close operationally before
 * SmartPay has received its commission, and vice versa.
 */
import type { AllocationSummary } from "@/lib/kit/allocation";

export type PaymentStatus = "created" | "pending" | "successful" | "failed" | "cancelled" | "reversed";
export type ReconState = "unreconciled" | "reconciled" | "exception" | "manually_reconciled";

export interface LifecycleFacts {
  payment: { status: PaymentStatus; createdAt: Date; confirmedAt: Date | null; reversedAt: Date | null };
  settlement: { lines: number; firstAt: Date | null; awaitingReconciliation: boolean };
  reconciliation: { state: ReconState; at: Date | null };
  allocations: AllocationSummary & { lastAt: Date | null };
  operationalClosure: { closedAt: Date } | null;
  commission: {
    /** number of ledger entries linked to the payment (accrual, adjustments, reversal) */
    entries: number;
    accruedMinor: number;
    accruedAt: Date | null;
    netMinor: number;
    reversed: boolean;
    invoicedEntries: number;
    invoicedAt: Date | null;
    /** entries whose invoice is fully paid */
    paidEntries: number;
    /** at least one entry sits in a partially paid invoice */
    partiallyPaid: boolean;
    collectedAt: Date | null;
  };
  financialClosure: { closedAt: Date } | null;
}

export type StageKey =
  | "payment_confirmed"
  | "bank_settlement"
  | "reconciliation"
  | "kit_allocation"
  | "operational_closure"
  | "commission_accrued"
  | "commission_invoiced"
  | "commission_collected"
  | "financial_closure";

export type StageState = "done" | "current" | "pending" | "attention" | "skipped";

export interface Stage {
  key: StageKey;
  label: string;
  side: "insurer" | "smartpay";
  state: StageState;
  at: Date | null;
  detail: string;
}

export const STAGE_LABELS: Record<StageKey, string> = {
  payment_confirmed: "Pagamento confirmado",
  bank_settlement: "Liquidação bancária",
  reconciliation: "Reconciliação",
  kit_allocation: "Alocação de Pagamentos",
  operational_closure: "Encerramento operacional da seguradora",
  commission_accrued: "Comissão apurada",
  commission_invoiced: "Comissão facturada",
  commission_collected: "Comissão recebida",
  financial_closure: "Encerramento financeiro SmartPay",
};

export const INSURER_STAGES: StageKey[] = ["payment_confirmed", "bank_settlement", "reconciliation", "kit_allocation", "operational_closure"];
export const SMARTPAY_STAGES: StageKey[] = ["commission_accrued", "commission_invoiced", "commission_collected", "financial_closure"];

const isReconciled = (s: ReconState) => s === "reconciled" || s === "manually_reconciled";
const wasConfirmed = (s: PaymentStatus) => s === "successful" || s === "reversed";

export interface ClosureCheck {
  ok: boolean;
  reasons: string[];
}

export function canCloseOperational(f: LifecycleFacts): ClosureCheck {
  const reasons: string[] = [];
  if (f.operationalClosure) reasons.push("A transacção já está encerrada operacionalmente.");
  if (f.payment.status === "successful") {
    if (!isReconciled(f.reconciliation.state)) reasons.push("O pagamento ainda não está reconciliado com o banco.");
    if (f.allocations.total === 0) reasons.push("Não existem notas de débito para alocar.");
    else if (f.allocations.allocated !== f.allocations.total) {
      reasons.push(`Faltam alocar ${f.allocations.total - f.allocations.allocated} de ${f.allocations.total} notas de débito no KIT.`);
    }
  } else if (f.payment.status === "reversed") {
    if (f.allocations.voided !== f.allocations.total) {
      reasons.push(`Pagamento revertido: anule as ${f.allocations.total - f.allocations.voided} alocação(ões) restantes no KIT.`);
    }
  } else {
    reasons.push("O pagamento não foi confirmado.");
  }
  return { ok: reasons.length === 0, reasons };
}

export function canCloseFinancial(f: LifecycleFacts): ClosureCheck {
  const reasons: string[] = [];
  const c = f.commission;
  if (f.financialClosure) reasons.push("A transacção já está encerrada financeiramente.");
  if (!wasConfirmed(f.payment.status)) reasons.push("O pagamento não foi confirmado.");
  else if (c.entries === 0) reasons.push("Não existe comissão registada para este pagamento.");
  else {
    const allPaid = c.paidEntries === c.entries;
    const cancelledOut = c.netMinor === 0 && c.invoicedEntries === 0;
    if (!allPaid && !cancelledOut) {
      if (c.invoicedEntries < c.entries) reasons.push(`${c.entries - c.invoicedEntries} movimento(s) de comissão por facturar.`);
      if (c.paidEntries < c.invoicedEntries) reasons.push("A factura da comissão ainda não está totalmente recebida.");
    }
  }
  return { ok: reasons.length === 0, reasons };
}

export function deriveStages(f: LifecycleFacts): Stage[] {
  const st = f.payment.status;
  const dead = st === "failed" || st === "cancelled";
  const confirmed = wasConfirmed(st);
  const stages: Stage[] = [];
  const push = (key: StageKey, state: StageState, at: Date | null, detail: string) =>
    stages.push({ key, label: STAGE_LABELS[key], side: INSURER_STAGES.includes(key) ? "insurer" : "smartpay", state, at, detail });

  // 1 — payment
  if (st === "successful") push("payment_confirmed", "done", f.payment.confirmedAt, "Confirmado pelo fornecedor (simulado)");
  else if (st === "reversed") push("payment_confirmed", "attention", f.payment.reversedAt, "Confirmado e depois revertido");
  else if (dead) push("payment_confirmed", "attention", null, st === "failed" ? "Pagamento falhado" : "Pagamento cancelado");
  else push("payment_confirmed", "current", null, st === "pending" ? "A aguardar confirmação do fornecedor" : "Pagamento iniciado");

  // 2 — bank settlement
  if (dead) push("bank_settlement", "skipped", null, "Não aplicável");
  else if (f.settlement.lines > 0)
    push("bank_settlement", "done", f.settlement.firstAt, f.settlement.awaitingReconciliation ? "Movimento recebido — aguarda reconciliação" : "Movimento bancário recebido");
  else push("bank_settlement", confirmed ? "current" : "pending", null, confirmed ? "A aguardar liquidação bancária" : "—");

  // 3 — reconciliation
  if (dead) push("reconciliation", "skipped", null, "Não aplicável");
  else if (isReconciled(f.reconciliation.state))
    push("reconciliation", "done", f.reconciliation.at, f.reconciliation.state === "manually_reconciled" ? "Reconciliado manualmente" : "Correspondência automática");
  else if (f.reconciliation.state === "exception") push("reconciliation", "attention", f.reconciliation.at, "Excepção por rever pela Finance");
  else push("reconciliation", f.settlement.lines > 0 ? "current" : "pending", null, f.settlement.lines > 0 ? "Por reconciliar pela Finance" : "—");

  // 4 — KIT allocation
  const a = f.allocations;
  if (dead) push("kit_allocation", "skipped", null, "Não aplicável");
  else if (a.state === "complete") push("kit_allocation", "done", a.lastAt, `${a.allocated}/${a.total} notas alocadas`);
  else if (a.state === "voided") push("kit_allocation", "done", a.lastAt, "Alocações anuladas no KIT");
  else if (a.state === "attention") push("kit_allocation", "attention", a.lastAt, `${a.issue} nota(s) com problema`);
  else if (st === "reversed" && a.total > 0) push("kit_allocation", "attention", a.lastAt, `Anular ${a.total - a.voided} alocação(ões) no KIT`);
  else if (isReconciled(f.reconciliation.state)) push("kit_allocation", "current", a.lastAt, `${a.allocated}/${a.total} notas alocadas`);
  else push("kit_allocation", "pending", null, a.total ? `${a.total} nota(s) por alocar após reconciliação` : "—");

  // 5 — operational closure
  if (dead) push("operational_closure", "skipped", null, "Não aplicável");
  else if (f.operationalClosure) push("operational_closure", "done", f.operationalClosure.closedAt, "Processo da seguradora concluído");
  else if (canCloseOperational(f).ok) push("operational_closure", "current", null, "Pronta para encerrar");
  else push("operational_closure", "pending", null, "—");

  // 6 — commission accrued
  const c = f.commission;
  if (dead) push("commission_accrued", "skipped", null, "Não aplicável");
  else if (c.accruedAt) push("commission_accrued", "done", c.accruedAt, c.reversed ? "Apurada e depois revertida" : "Apurada no ledger");
  else if (confirmed) push("commission_accrued", "attention", null, "Sem regra de comissão aplicável");
  else push("commission_accrued", "pending", null, "—");

  // 7 — invoiced
  const cancelledOut = c.entries > 0 && c.netMinor === 0 && c.invoicedEntries === 0;
  if (dead) push("commission_invoiced", "skipped", null, "Não aplicável");
  else if (cancelledOut) push("commission_invoiced", "skipped", null, "Comissão anulada — nada a facturar");
  else if (c.entries > 0 && c.invoicedEntries === c.entries) push("commission_invoiced", "done", c.invoicedAt, "Incluída em factura");
  else if (c.invoicedEntries > 0) push("commission_invoiced", "current", c.invoicedAt, `${c.entries - c.invoicedEntries} movimento(s) por facturar`);
  else push("commission_invoiced", c.entries > 0 ? "current" : "pending", null, c.entries > 0 ? "Por facturar" : "—");

  // 8 — collected (an accrual is NOT a collection)
  if (dead) push("commission_collected", "skipped", null, "Não aplicável");
  else if (cancelledOut) push("commission_collected", "skipped", null, "Nada a receber");
  else if (c.entries > 0 && c.paidEntries === c.entries) push("commission_collected", "done", c.collectedAt, "Cobrança registada (simulada)");
  else if (c.partiallyPaid || c.paidEntries > 0) push("commission_collected", "current", c.collectedAt, "Recebida parcialmente");
  else push("commission_collected", c.invoicedEntries > 0 ? "current" : "pending", null, c.invoicedEntries > 0 ? "A aguardar recebimento" : "—");

  // 9 — financial closure
  if (dead) push("financial_closure", "skipped", null, "Não aplicável");
  else if (f.financialClosure) push("financial_closure", "done", f.financialClosure.closedAt, "Processo SmartPay concluído");
  else if (canCloseFinancial(f).ok) push("financial_closure", "current", null, "Pronta para encerrar");
  else push("financial_closure", "pending", null, "—");

  return stages;
}

/** Short status label for list views. */
export function overallLabel(stages: readonly Stage[]): { insurer: string; smartpay: string } {
  const label = (keys: StageKey[]) => {
    const own = stages.filter((s) => keys.includes(s.key));
    if (own.every((s) => s.state === "skipped")) return "Não aplicável";
    const last = own[own.length - 1]!;
    if (last.state === "done") return "Encerrada";
    const att = own.find((s) => s.state === "attention");
    if (att) return `Atenção: ${att.label}`;
    const cur = own.find((s) => s.state === "current");
    return cur ? cur.label : "Em curso";
  };
  return { insurer: label(INSURER_STAGES), smartpay: label(SMARTPAY_STAGES) };
}
