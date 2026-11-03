/**
 * Reconciliation matcher — PURE. Classifies each settlement line against the
 * payment records. Payment confirmation (provider says "successful") and bank
 * reconciliation (money observed in a settlement) are DIFFERENT stages: a payment
 * is only reconciled when a settlement line matches it here (or a human resolves
 * an exception with a recorded reason).
 *
 * Line kinds (V1.1):
 * - "statement": an actual movement on the bank statement.
 * - "detail": a breakdown line that belongs to an AGGREGATED statement credit
 *   (parentReference = the statement line's settlementReference). Detail lines carry
 *   the payment references; the aggregated credit carries the money. A payment inside
 *   an aggregate is reconciled only if its detail line matches AND the aggregate balances
 *   (sum of detail lines == aggregated credit).
 */

export type MovementKind = "credit" | "fee_debit" | "reversal_debit";

export interface SettlementLine {
  rowNumber: number;
  settlementReference: string;
  paymentReference: string | null;
  bankAccountCode: string | null;
  movementType: MovementKind;
  grossAmountMinor: number;
  reportedStatus: string | null;
  lineKind?: "statement" | "detail";
  parentReference?: string | null;
  /** When provided, net must equal gross (fees charged separately) or gross − gateway − platform (fees deducted). */
  netAmountMinor?: number;
  gatewayFeeMinor?: number;
  platformFeeMinor?: number;
}

export interface PaymentSnapshot {
  id: string;
  reference: string;
  amountMinor: number;
  bankAccountCode: string;
  status: "created" | "pending" | "successful" | "failed" | "cancelled" | "reversed";
  alreadyReconciled: boolean;
}

export type MatchStatus = "matched" | "unmatched" | "amount_mismatch" | "duplicate_settlement" | "under_review";

export type ReasonCode =
  | "MATCHED"
  | "FEE_MOVEMENT_IDENTIFIED"
  | "REVERSAL_CONFIRMED"
  | "AGGREGATE_BALANCED"
  | "AGGREGATE_UNBALANCED"
  | "DETAIL_IN_UNBALANCED_AGGREGATE"
  | "ORPHAN_DETAIL_LINE"
  | "NET_ARITHMETIC_MISMATCH"
  | "DUPLICATE_SETTLEMENT_REFERENCE"
  | "PAYMENT_ALREADY_SETTLED"
  | "MISSING_PAYMENT_REFERENCE"
  | "UNKNOWN_PAYMENT_REFERENCE"
  | "PAYMENT_NOT_SUCCESSFUL"
  | "PAYMENT_STILL_PENDING"
  | "REVERSAL_FOR_NON_REVERSED_PAYMENT"
  | "AMOUNT_MISMATCH"
  | "ACCOUNT_MISMATCH"
  | "STATUS_MISMATCH";

export interface MatchResult {
  rowNumber: number;
  status: MatchStatus;
  reasonCode: ReasonCode;
  paymentId: string | null;
  expectedAmountMinor: number | null;
  settledAmountMinor: number;
  differenceMinor: number | null;
  /** true when the settlement reference itself is a duplicate (row kept for audit, never re-applied). */
  isDuplicateRow: boolean;
}

const SUCCESS_STATUSES = new Set(["SUCCESS", "SUCCESSFUL", "SETTLED", "COMPLETED", "PAID", "OK"]);
const REVERSAL_STATUSES = new Set(["REVERSED", "REVERSAL", "REFUNDED", "CHARGEBACK"]);

const norm = (s: string) => s.trim().toUpperCase();

export function netIsConsistent(line: Pick<SettlementLine, "grossAmountMinor" | "netAmountMinor" | "gatewayFeeMinor" | "platformFeeMinor">): boolean {
  if (line.netAmountMinor === undefined) return true;
  const fees = (line.gatewayFeeMinor ?? 0) + (line.platformFeeMinor ?? 0);
  return line.netAmountMinor === line.grossAmountMinor || line.netAmountMinor === line.grossAmountMinor - fees;
}

export function matchSettlementLines(
  lines: readonly SettlementLine[],
  payments: ReadonlyMap<string, PaymentSnapshot>,
  existingSettlementRefs: ReadonlySet<string>,
): MatchResult[] {
  const seenRefs = new Set<string>();
  const settledInThisFile = new Set<string>();
  const results: MatchResult[] = new Array(lines.length);

  // Aggregated statement credits = statement credits without a payment reference that have detail lines in this file.
  const statementRefs = new Set(lines.filter((l) => (l.lineKind ?? "statement") === "statement").map((l) => norm(l.settlementReference)));
  const childrenOf = new Map<string, number[]>();
  lines.forEach((l, i) => {
    if (l.lineKind === "detail" && l.parentReference) {
      const p = norm(l.parentReference);
      childrenOf.set(p, [...(childrenOf.get(p) ?? []), i]);
    }
  });
  const aggregateIdx: number[] = [];

  lines.forEach((line, i) => {
    const ref = norm(line.settlementReference);
    const base = {
      rowNumber: line.rowNumber,
      settledAmountMinor: line.grossAmountMinor,
      paymentId: null as string | null,
      expectedAmountMinor: null as number | null,
      differenceMinor: null as number | null,
      isDuplicateRow: false,
    };
    const put = (r: Omit<MatchResult, "rowNumber" | "settledAmountMinor" | "isDuplicateRow"> & Partial<MatchResult>) => {
      results[i] = { ...base, ...r } as MatchResult;
    };

    // 1. Duplicate settlement reference (already imported, or repeated within the file).
    if (existingSettlementRefs.has(ref) || seenRefs.has(ref)) {
      put({ status: "duplicate_settlement", reasonCode: "DUPLICATE_SETTLEMENT_REFERENCE", paymentId: null, expectedAmountMinor: null, differenceMinor: null, isDuplicateRow: true });
      return;
    }
    seenRefs.add(ref);

    // 2. Fee movements are identified movements without a single payment.
    if (line.movementType === "fee_debit") {
      put({ status: "matched", reasonCode: "FEE_MOVEMENT_IDENTIFIED", paymentId: null, expectedAmountMinor: null, differenceMinor: null });
      return;
    }

    const isDetail = line.lineKind === "detail";
    if (isDetail && (!line.parentReference || !statementRefs.has(norm(line.parentReference)))) {
      put({ status: "under_review", reasonCode: "ORPHAN_DETAIL_LINE", paymentId: null, expectedAmountMinor: null, differenceMinor: null });
      return;
    }

    const pRef = line.paymentReference ? norm(line.paymentReference) : "";
    if (!pRef) {
      if (!isDetail && line.movementType === "credit" && childrenOf.has(ref)) {
        aggregateIdx.push(i); // resolved after its detail lines
        return;
      }
      put({ status: "unmatched", reasonCode: "MISSING_PAYMENT_REFERENCE", paymentId: null, expectedAmountMinor: null, differenceMinor: null });
      return;
    }
    const payment = payments.get(pRef);
    if (!payment) {
      put({ status: "unmatched", reasonCode: "UNKNOWN_PAYMENT_REFERENCE", paymentId: null, expectedAmountMinor: null, differenceMinor: null });
      return;
    }
    const withPayment = { paymentId: payment.id, expectedAmountMinor: payment.amountMinor, differenceMinor: line.grossAmountMinor - payment.amountMinor };

    // 3. Reversal debits must correspond to a reversed payment.
    if (line.movementType === "reversal_debit") {
      if (payment.status !== "reversed") put({ ...withPayment, status: "under_review", reasonCode: "REVERSAL_FOR_NON_REVERSED_PAYMENT" });
      else if (line.grossAmountMinor !== payment.amountMinor) put({ ...withPayment, status: "amount_mismatch", reasonCode: "AMOUNT_MISMATCH" });
      else put({ ...withPayment, status: "matched", reasonCode: "REVERSAL_CONFIRMED" });
      return;
    }

    // 4. A payment can only be settled once.
    if (payment.alreadyReconciled || settledInThisFile.has(pRef)) {
      put({ ...withPayment, status: "duplicate_settlement", reasonCode: "PAYMENT_ALREADY_SETTLED" });
      return;
    }

    // 5. Payment must be confirmed successful (or reversed after settlement) on our side.
    if (payment.status === "pending" || payment.status === "created") {
      put({ ...withPayment, status: "under_review", reasonCode: "PAYMENT_STILL_PENDING" });
      return;
    }
    if (payment.status !== "successful" && payment.status !== "reversed") {
      put({ ...withPayment, status: "unmatched", reasonCode: "PAYMENT_NOT_SUCCESSFUL" });
      return;
    }

    // 6. Amount must match exactly (minor units).
    if (line.grossAmountMinor !== payment.amountMinor) {
      put({ ...withPayment, status: "amount_mismatch", reasonCode: "AMOUNT_MISMATCH" });
      return;
    }

    // 7. Net must be gross, or gross minus the itemised fees.
    if (!netIsConsistent(line)) {
      put({ ...withPayment, status: "under_review", reasonCode: "NET_ARITHMETIC_MISMATCH" });
      return;
    }

    // 8. Destination account must match.
    if (line.bankAccountCode && norm(line.bankAccountCode) !== payment.bankAccountCode.toUpperCase()) {
      put({ ...withPayment, status: "under_review", reasonCode: "ACCOUNT_MISMATCH" });
      return;
    }

    // 9. Reported status (if provided) must indicate success.
    const reported = line.reportedStatus ? norm(line.reportedStatus) : "";
    if (reported && !SUCCESS_STATUSES.has(reported) && !REVERSAL_STATUSES.has(reported)) {
      put({ ...withPayment, status: "under_review", reasonCode: "STATUS_MISMATCH" });
      return;
    }

    settledInThisFile.add(pRef);
    put({ ...withPayment, status: "matched", reasonCode: "MATCHED" });
  });

  // 10. Aggregated credits: balanced only if the detail lines add up and every detail matched.
  for (const i of aggregateIdx) {
    const agg = lines[i]!;
    const kids = (childrenOf.get(norm(agg.settlementReference)) ?? []).filter((k) => !results[k]!.isDuplicateRow);
    const detailSum = kids.reduce((a, k) => a + lines[k]!.grossAmountMinor, 0);
    const expected = kids.reduce((a, k) => a + (results[k]!.expectedAmountMinor ?? 0), 0);
    const allMatched = kids.length > 0 && kids.every((k) => results[k]!.status === "matched");
    const balanced = detailSum === agg.grossAmountMinor && allMatched;
    results[i] = {
      rowNumber: agg.rowNumber,
      status: balanced ? "matched" : "under_review",
      reasonCode: balanced ? "AGGREGATE_BALANCED" : "AGGREGATE_UNBALANCED",
      paymentId: null,
      expectedAmountMinor: expected,
      settledAmountMinor: agg.grossAmountMinor,
      differenceMinor: agg.grossAmountMinor - detailSum,
      isDuplicateRow: false,
    };
    if (!balanced) {
      for (const k of kids) {
        if (results[k]!.status === "matched") results[k] = { ...results[k]!, status: "under_review", reasonCode: "DETAIL_IN_UNBALANCED_AGGREGATE" };
      }
    }
  }

  return results;
}

export function summarize(results: readonly MatchResult[]) {
  const counts: Record<MatchStatus, number> = {
    matched: 0,
    unmatched: 0,
    amount_mismatch: 0,
    duplicate_settlement: 0,
    under_review: 0,
  };
  for (const r of results) counts[r.status]++;
  return { counts, exceptions: results.length - counts.matched };
}

export const REASON_LABELS: Record<ReasonCode, string> = {
  MATCHED: "Referência, valor, conta e estado coincidem",
  FEE_MOVEMENT_IDENTIFIED: "Movimento de taxas identificado",
  REVERSAL_CONFIRMED: "Reversão confirmada no extracto",
  AGGREGATE_BALANCED: "Crédito agregado igual à soma dos pagamentos",
  AGGREGATE_UNBALANCED: "Crédito agregado não corresponde à soma das linhas de detalhe",
  DETAIL_IN_UNBALANCED_AGGREGATE: "Linha correcta, mas o crédito agregado não está equilibrado",
  ORPHAN_DETAIL_LINE: "Linha de detalhe sem crédito agregado correspondente",
  NET_ARITHMETIC_MISMATCH: "Valor líquido não corresponde ao bruto menos as taxas",
  DUPLICATE_SETTLEMENT_REFERENCE: "Referência de liquidação duplicada",
  PAYMENT_ALREADY_SETTLED: "Pagamento já liquidado noutra linha",
  MISSING_PAYMENT_REFERENCE: "Linha sem referência de pagamento",
  UNKNOWN_PAYMENT_REFERENCE: "Referência de pagamento desconhecida",
  PAYMENT_NOT_SUCCESSFUL: "Pagamento não foi bem-sucedido",
  PAYMENT_STILL_PENDING: "Pagamento ainda pendente",
  REVERSAL_FOR_NON_REVERSED_PAYMENT: "Débito de reversão para pagamento não revertido",
  AMOUNT_MISMATCH: "Valor liquidado diferente do valor pago",
  ACCOUNT_MISMATCH: "Conta de destino diferente",
  STATUS_MISMATCH: "Estado reportado não indica sucesso",
};
