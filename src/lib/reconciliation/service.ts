import "server-only";
import { and, asc, eq, inArray, ne, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database, Executor } from "@/lib/db";
import {
  bankAccounts,
  bankSettlements,
  commissionEntries,
  paymentIntents,
  reconciliationRecords,
  settlementBatches,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { HttpError } from "@/lib/http";
import { recordEvents, type LifecycleEventInput } from "@/lib/lifecycle/events";
import { formatMzn } from "@/lib/money";
import { sha256Hex } from "@/lib/security/crypto";
import type { MockPaymentProvider } from "@/lib/payments/mock-provider";
import { SCENARIOS, type FeeTreatment, type ScenarioKey } from "@/lib/settlement/scenarios";
import { matchSettlementLines, REASON_LABELS, summarize, type PaymentSnapshot, type SettlementLine } from "./matcher";
import type { ParsedSettlementRow } from "./parser";

type Actor = { userId: string | null };

export interface ImportInput {
  organizationId: string;
  source: "simulated_provider" | "file_import";
  scenario: ScenarioKey | "file";
  fileName: string | null;
  fileHash: string | null;
  rows: ParsedSettlementRow[];
}

const FEE_TREATMENT_BY_SCENARIO: Record<ScenarioKey | "file", FeeTreatment> = {
  gross: "invoiced_separately",
  net: "deducted",
  separate_fee_debit: "debited_separately",
  aggregated: "invoiced_separately",
  reversal: "not_applicable",
  file: "invoiced_separately",
};

/**
 * V1.0-compatible entry point: ingest a settlement AND reconcile it immediately
 * (used by the Finance team's own file import).
 */
export async function importSettlement(db: Database, input: ImportInput, actor: Actor) {
  return ingestSettlement(db, input, actor, { reconcile: true });
}

/**
 * Stores settlement lines as a batch. With `reconcile: false` (provider/simulated settlements),
 * the batch waits in state "pending" until the Finance team reconciles it — receiving money
 * in the bank and reconciling it are different steps performed by different people.
 */
export async function ingestSettlement(db: Database, input: ImportInput, actor: Actor, opts: { reconcile: boolean }) {
  if (input.rows.length === 0) throw new HttpError(422, "empty_file", "O ficheiro não tem linhas de liquidação.");

  // Structural validation of aggregated credits before touching the database.
  const byRef = new Map(input.rows.map((r) => [r.settlementReference.toUpperCase(), r]));
  for (const r of input.rows) {
    if (r.lineKind !== "detail") continue;
    const parent = r.parentReference ? byRef.get(r.parentReference.toUpperCase()) : undefined;
    if (!parent || parent.lineKind !== "statement" || parent.movementType !== "credit" || parent.paymentReference) {
      throw new HttpError(422, "invalid_aggregate", `Linha ${r.rowNumber}: a linha de detalhe não aponta para um crédito agregado deste ficheiro.`, [
        { row: r.rowNumber, message: "parent_reference inválida" },
      ]);
    }
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"settlement_import:" + input.organizationId}))`);

    if (input.fileHash) {
      const [dup] = await tx
        .select({ ref: settlementBatches.batchReference })
        .from(settlementBatches)
        .where(and(eq(settlementBatches.organizationId, input.organizationId), eq(settlementBatches.fileHash, input.fileHash)))
        .limit(1);
      if (dup) throw new HttpError(409, "duplicate_file", `Este ficheiro já foi importado (lote ${dup.ref}). Nenhuma linha foi reprocessada.`);
    }

    // Duplicate settlement references are decided at ingestion (they are never re-applied).
    const existing = await tx
      .select({ ref: bankSettlements.settlementReference })
      .from(bankSettlements)
      .where(
        and(
          eq(bankSettlements.organizationId, input.organizationId),
          eq(bankSettlements.isDuplicateRow, false),
          inArray(bankSettlements.settlementReference, input.rows.map((r) => r.settlementReference)),
        ),
      );
    const seen = new Set(existing.map((e) => e.ref));

    const now = new Date();
    const batchReference = `SB-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${sha256Hex(`${input.organizationId}:${now.getTime()}:${Math.random()}`).slice(0, 6).toUpperCase()}`;
    const [batch] = await tx
      .insert(settlementBatches)
      .values({
        organizationId: input.organizationId,
        batchReference,
        source: input.source,
        scenario: input.scenario,
        featureStatus: "simulated",
        fileName: input.fileName,
        fileHash: input.fileHash,
        rowCount: input.rows.length,
        totalGrossMinor: input.rows.filter((r) => r.movementType === "credit" && r.lineKind === "statement").reduce((a, r) => a + r.grossAmountMinor, 0),
        createdBy: actor.userId,
        reconciliationState: "pending",
        feeTreatment: FEE_TREATMENT_BY_SCENARIO[input.scenario],
      })
      .returning();

    // Statement lines first, so detail lines can reference their aggregated credit.
    const ordered = [...input.rows].sort((a, b) => (a.lineKind === b.lineKind ? a.rowNumber - b.rowNumber : a.lineKind === "statement" ? -1 : 1));
    const idByRef = new Map<string, string>();
    const inserted: { id: string; row: ParsedSettlementRow }[] = [];
    for (const row of ordered) {
      const ref = row.settlementReference.toUpperCase();
      const isDuplicateRow = seen.has(ref);
      seen.add(ref);
      const [line] = await tx
        .insert(bankSettlements)
        .values({
          organizationId: input.organizationId,
          batchId: batch!.id,
          settlementReference: row.settlementReference,
          paymentReference: row.paymentReference,
          bankAccountCode: row.bankAccountCode,
          movementType: row.movementType,
          grossAmountMinor: row.grossAmountMinor,
          gatewayFeeMinor: row.gatewayFeeMinor,
          platformFeeMinor: row.platformFeeMinor,
          netAmountMinor: row.netAmountMinor,
          reportedStatus: row.reportedStatus,
          valueDate: row.valueDate,
          rowNumber: row.rowNumber,
          isDuplicateRow,
          lineKind: row.lineKind,
          parentSettlementId: row.lineKind === "detail" ? idByRef.get(row.parentReference!.toUpperCase())! : null,
          feeKind: row.feeKind,
        })
        .returning({ id: bankSettlements.id });
      if (!isDuplicateRow) idByRef.set(ref, line!.id);
      else if (!idByRef.has(ref)) idByRef.set(ref, line!.id);
      inserted.push({ id: line!.id, row });
    }

    // Timeline: one "settlement received" event per payment line of this tenant.
    const refs = [...new Set(input.rows.map((r) => r.paymentReference).filter((r): r is string => !!r))];
    const pays = refs.length
      ? await tx
          .select({ id: paymentIntents.id, reference: paymentIntents.reference, isSimulated: paymentIntents.isSimulated })
          .from(paymentIntents)
          .where(and(eq(paymentIntents.organizationId, input.organizationId), inArray(paymentIntents.reference, refs)))
      : [];
    const scenarioLabel = input.scenario === "file" ? `ficheiro ${input.fileName ?? ""}`.trim() : SCENARIOS[input.scenario].label.toLowerCase();
    await recordEvents(
      tx,
      inserted.flatMap<LifecycleEventInput>(({ id, row }) => {
        const p = pays.find((x) => x.reference === row.paymentReference);
        if (!p) return [];
        const reversal = row.movementType === "reversal_debit";
        return [
          {
            organizationId: input.organizationId,
            paymentIntentId: p.id,
            stage: "settlement",
            eventType: reversal ? "settlement.reversal_debit" : "settlement.received",
            actorType: input.source === "file_import" ? "user" : "provider",
            actorUserId: input.source === "file_import" ? actor.userId : null,
            summary: reversal
              ? `Débito de reversão de ${formatMzn(row.grossAmountMinor)} no extracto (lote ${batchReference}, simulado)`
              : `Liquidação de ${formatMzn(row.grossAmountMinor)} recebida — ${scenarioLabel}${row.lineKind === "detail" ? " (dentro de crédito agregado)" : ""} · lote ${batchReference} (simulada)`,
            metadata: {
              batchReference,
              settlementReference: row.settlementReference,
              lineKind: row.lineKind,
              grossMinor: row.grossAmountMinor,
              gatewayFeeMinor: row.gatewayFeeMinor,
              platformFeeMinor: row.platformFeeMinor,
              netMinor: row.netAmountMinor,
            },
            isSimulated: p.isSimulated,
            dedupeKey: `settlement:${id}`,
            occurredAt: now,
          },
        ];
      }),
    );

    await writeAudit(tx, {
      organizationId: input.organizationId,
      actorType: actor.userId ? "user" : "system",
      actorUserId: actor.userId,
      action: input.source === "file_import" ? "reconciliation.file_imported" : "settlement.simulated_received",
      entityType: "settlement_batch",
      entityId: batch!.id,
      metadata: { batchReference, fileName: input.fileName, scenario: input.scenario, rows: input.rows.length, simulated: true },
    });

    if (!opts.reconcile) {
      return { batch: batch!, counts: null, exceptions: null };
    }
    const r = await reconcileBatchInTx(tx, { organizationId: input.organizationId, batchId: batch!.id }, actor);
    return { batch: r.batch, counts: r.counts, exceptions: r.exceptions };
  });
}

/** Finance action: reconcile a pending batch (provider settlement) against the payments. */
export async function reconcileBatch(db: Database, input: { organizationId: string; batchId: string }, actor: Actor) {
  return db.transaction((tx) => reconcileBatchInTx(tx, input, actor));
}

async function reconcileBatchInTx(tx: Executor, input: { organizationId: string; batchId: string }, actor: Actor) {
  const [batch] = await tx
    .select()
    .from(settlementBatches)
    .where(and(eq(settlementBatches.id, input.batchId), eq(settlementBatches.organizationId, input.organizationId)))
    .limit(1)
    .for("update");
  if (!batch) throw new HttpError(404, "not_found", "Lote de liquidação não encontrado.");
  if (batch.reconciliationState !== "pending") throw new HttpError(409, "already_reconciled", "Este lote já foi reconciliado.");

  const parent = alias(bankSettlements, "parent");
  const rows = await tx
    .select({ line: bankSettlements, parentRef: parent.settlementReference })
    .from(bankSettlements)
    .leftJoin(parent, eq(parent.id, bankSettlements.parentSettlementId))
    .where(eq(bankSettlements.batchId, batch.id))
    .orderBy(asc(bankSettlements.rowNumber));

  // Tenant-scoped lookups ONLY — another tenant's references can never match.
  const refs = [...new Set(rows.map((r) => r.line.paymentReference).filter((r): r is string => !!r))];
  const paymentRows = refs.length
    ? await tx
        .select({
          id: paymentIntents.id,
          reference: paymentIntents.reference,
          amountMinor: paymentIntents.amountMinor,
          status: paymentIntents.status,
          reconciliationStatus: paymentIntents.reconciliationStatus,
          isSimulated: paymentIntents.isSimulated,
          bankAccountCode: bankAccounts.code,
        })
        .from(paymentIntents)
        .innerJoin(bankAccounts, eq(bankAccounts.id, paymentIntents.bankAccountId))
        .where(and(eq(paymentIntents.organizationId, input.organizationId), inArray(paymentIntents.reference, refs)))
        .for("update", { of: paymentIntents })
    : [];
  const payments = new Map<string, PaymentSnapshot>(
    paymentRows.map((p) => [
      p.reference,
      {
        id: p.id,
        reference: p.reference,
        amountMinor: p.amountMinor,
        status: p.status,
        bankAccountCode: p.bankAccountCode,
        alreadyReconciled: p.reconciliationStatus === "reconciled" || p.reconciliationStatus === "manually_reconciled",
      },
    ]),
  );

  // References already present (as non-duplicates) in OTHER batches of this tenant.
  const otherRefs = await tx
    .select({ ref: bankSettlements.settlementReference })
    .from(bankSettlements)
    .where(
      and(
        eq(bankSettlements.organizationId, input.organizationId),
        eq(bankSettlements.isDuplicateRow, false),
        ne(bankSettlements.batchId, batch.id),
        inArray(bankSettlements.settlementReference, rows.map((r) => r.line.settlementReference)),
      ),
    );

  const lines: SettlementLine[] = rows.map(({ line, parentRef }) => ({
    rowNumber: line.rowNumber,
    settlementReference: line.settlementReference,
    paymentReference: line.paymentReference,
    bankAccountCode: line.bankAccountCode,
    movementType: line.movementType,
    grossAmountMinor: line.grossAmountMinor,
    reportedStatus: line.reportedStatus,
    lineKind: line.lineKind,
    parentReference: parentRef,
    netAmountMinor: line.netAmountMinor,
    gatewayFeeMinor: line.gatewayFeeMinor,
    platformFeeMinor: line.platformFeeMinor,
  }));
  const results = matchSettlementLines(lines, payments, new Set(otherRefs.map((r) => r.ref)));
  const { counts, exceptions } = summarize(results);
  const now = new Date();

  const reconciled: string[] = [];
  const flagged: string[] = [];
  const events: LifecycleEventInput[] = [];
  for (let i = 0; i < rows.length; i++) {
    const line = rows[i]!.line;
    const res = results[i]!;
    const [rec] = await tx
      .insert(reconciliationRecords)
      .values({
        organizationId: input.organizationId,
        batchId: batch.id,
        bankSettlementId: line.id,
        paymentIntentId: res.paymentId,
        status: res.status,
        reasonCode: res.reasonCode,
        expectedAmountMinor: res.expectedAmountMinor,
        settledAmountMinor: res.settledAmountMinor,
        differenceMinor: res.differenceMinor,
      })
      .returning({ id: reconciliationRecords.id });
    if (res.paymentId && line.movementType === "credit") {
      if (res.status === "matched") reconciled.push(res.paymentId);
      else if (res.status !== "duplicate_settlement") flagged.push(res.paymentId);
    }
    if (res.paymentId) {
      const p = paymentRows.find((x) => x.id === res.paymentId);
      const ok = res.status === "matched";
      events.push({
        organizationId: input.organizationId,
        paymentIntentId: res.paymentId,
        stage: "reconciliation",
        eventType: ok ? "reconciliation.matched" : "reconciliation.exception",
        actorType: actor.userId ? "user" : "system",
        actorUserId: actor.userId,
        summary: ok
          ? `Reconciliação: ${REASON_LABELS[res.reasonCode].toLowerCase()} (lote ${batch.batchReference})`
          : `Excepção de reconciliação: ${REASON_LABELS[res.reasonCode]} (lote ${batch.batchReference})`,
        metadata: { reasonCode: res.reasonCode, batchReference: batch.batchReference, differenceMinor: res.differenceMinor },
        isSimulated: p?.isSimulated ?? true,
        dedupeKey: `recon:${rec!.id}:initial`,
        occurredAt: now,
      });
    }
  }

  if (reconciled.length) {
    await tx
      .update(paymentIntents)
      .set({ reconciliationStatus: "reconciled" })
      .where(and(eq(paymentIntents.organizationId, input.organizationId), inArray(paymentIntents.id, reconciled)));
  }
  if (flagged.length) {
    // Never downgrade a reconciled payment.
    await tx
      .update(paymentIntents)
      .set({ reconciliationStatus: "exception" })
      .where(and(eq(paymentIntents.organizationId, input.organizationId), inArray(paymentIntents.id, flagged), eq(paymentIntents.reconciliationStatus, "unreconciled")));
  }
  const [updated] = await tx
    .update(settlementBatches)
    .set({ reconciliationState: "reconciled", reconciledAt: now, reconciledBy: actor.userId, matchedCount: counts.matched, exceptionCount: exceptions })
    .where(eq(settlementBatches.id, batch.id))
    .returning();
  await recordEvents(tx, events);
  await writeAudit(tx, {
    organizationId: input.organizationId,
    actorType: actor.userId ? "user" : "system",
    actorUserId: actor.userId,
    action: "reconciliation.batch_reconciled",
    entityType: "settlement_batch",
    entityId: batch.id,
    metadata: { batchReference: batch.batchReference, counts },
  });
  return { batch: updated!, counts, exceptions };
}

/**
 * SIMULATED provider settlement. Selects successful payments that have no settlement
 * line yet (or reversed payments without a reversal debit) — optionally a given set —
 * and stores the batch PENDING reconciliation by the Finance team.
 */
export async function generateSimulatedSettlement(
  db: Database,
  provider: MockPaymentProvider,
  input: { organizationId: string; scenario: ScenarioKey; limit?: number; paymentIds?: string[] },
  actor: Actor,
) {
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 200);
  const reversal = input.scenario === "reversal";
  const candidates = await db
    .select({
      id: paymentIntents.id,
      reference: paymentIntents.reference,
      amountMinor: paymentIntents.amountMinor,
      method: paymentIntents.paymentMethod,
      bankAccountCode: bankAccounts.code,
      commissionMinor: sql<string>`coalesce((select sum(${commissionEntries.amountMinor}) from ${commissionEntries} where ${commissionEntries.paymentIntentId} = ${paymentIntents.id} and ${commissionEntries.entryType} = 'accrual'), 0)`,
    })
    .from(paymentIntents)
    .innerJoin(bankAccounts, eq(bankAccounts.id, paymentIntents.bankAccountId))
    .where(
      and(
        eq(paymentIntents.organizationId, input.organizationId),
        eq(paymentIntents.status, reversal ? "reversed" : "successful"),
        input.paymentIds?.length ? inArray(paymentIntents.id, input.paymentIds) : undefined,
        notExists(
          db
            .select({ one: sql`1` })
            .from(bankSettlements)
            .where(
              and(
                eq(bankSettlements.organizationId, input.organizationId),
                eq(bankSettlements.paymentReference, paymentIntents.reference),
                eq(bankSettlements.isDuplicateRow, false),
                eq(bankSettlements.movementType, reversal ? "reversal_debit" : "credit"),
              ),
            ),
        ),
      ),
    )
    .orderBy(paymentIntents.createdAt)
    .limit(limit);

  if (candidates.length === 0) {
    throw new HttpError(422, "nothing_to_settle", reversal ? "Não há pagamentos revertidos por liquidar." : "Não há pagamentos bem-sucedidos por liquidar.");
  }
  const batchReference = `SIM-${input.scenario.toUpperCase().replace(/_/g, "")}-${Date.now().toString(36).toUpperCase()}`;
  const lines = await provider.getSettlementDetails({
    batchReference,
    scenario: input.scenario,
    payments: candidates.map((c) => ({ reference: c.reference, amountMinor: c.amountMinor, method: c.method, bankAccountCode: c.bankAccountCode, commissionMinor: Number(c.commissionMinor) })),
  });
  const today = new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);
  const result = await ingestSettlement(
    db,
    {
      organizationId: input.organizationId,
      source: "simulated_provider",
      scenario: input.scenario,
      fileName: null,
      fileHash: null,
      rows: lines.map((l, i) => ({ ...l, rowNumber: i + 1, valueDate: today })),
    },
    actor,
    { reconcile: false },
  );
  return { ...result, payments: candidates.length, lines: lines.length };
}

/** Human resolution of a reconciliation exception — reason is mandatory and audited. */
export async function resolveException(
  db: Database,
  input: { organizationId: string; recordId: string; decision: "manually_reconciled" | "rejected" | "under_review"; reason: string },
  actor: Actor,
) {
  const reason = input.reason.trim();
  if (reason.length < 10) throw new HttpError(422, "reason_required", "Indique um motivo detalhado (mín. 10 caracteres).");
  return db.transaction(async (tx) => {
    const [rec] = await tx
      .select()
      .from(reconciliationRecords)
      .where(and(eq(reconciliationRecords.id, input.recordId), eq(reconciliationRecords.organizationId, input.organizationId)))
      .limit(1)
      .for("update");
    if (!rec) throw new HttpError(404, "not_found", "Registo de reconciliação não encontrado.");
    if (rec.status === "matched" || rec.status === "manually_reconciled" || rec.status === "rejected") {
      throw new HttpError(409, "already_resolved", "Este registo já está resolvido.");
    }
    if (input.decision === "manually_reconciled") {
      if (!rec.paymentIntentId) throw new HttpError(422, "no_payment", "Sem pagamento associado — só pode ser rejeitado ou mantido em revisão.");
      const [p] = await tx
        .select({ status: paymentIntents.status, recon: paymentIntents.reconciliationStatus })
        .from(paymentIntents)
        .where(eq(paymentIntents.id, rec.paymentIntentId));
      if (!p || (p.status !== "successful" && p.status !== "reversed")) {
        throw new HttpError(422, "payment_not_successful", "Só pagamentos bem-sucedidos podem ser reconciliados.");
      }
      if (p.recon === "reconciled" || p.recon === "manually_reconciled") {
        throw new HttpError(409, "payment_already_reconciled", "O pagamento já está reconciliado por outra liquidação.");
      }
    }
    const now = new Date();
    await tx
      .update(reconciliationRecords)
      .set({ status: input.decision, reviewReason: reason, reviewedBy: actor.userId, reviewedAt: now })
      .where(eq(reconciliationRecords.id, rec.id));
    if (input.decision === "manually_reconciled" && rec.paymentIntentId) {
      await tx.update(paymentIntents).set({ reconciliationStatus: "manually_reconciled" }).where(eq(paymentIntents.id, rec.paymentIntentId));
    }
    await writeAudit(tx, {
      organizationId: input.organizationId,
      actorType: "user",
      actorUserId: actor.userId,
      action: "reconciliation.exception_reviewed",
      entityType: "reconciliation_record",
      entityId: rec.id,
      metadata: { from: rec.status, to: input.decision, reason, reasonCode: rec.reasonCode },
    });
    if (rec.paymentIntentId) {
      const LABEL = { manually_reconciled: "Reconciliado manualmente", rejected: "Linha de liquidação rejeitada", under_review: "Mantido em revisão" } as const;
      await recordEvents(tx, [
        {
          organizationId: input.organizationId,
          paymentIntentId: rec.paymentIntentId,
          stage: "reconciliation",
          eventType: `reconciliation.${input.decision}`,
          actorType: "user",
          actorUserId: actor.userId,
          summary: `${LABEL[input.decision]} — ${reason}`,
          metadata: { reasonCode: rec.reasonCode, from: rec.status },
          dedupeKey: `recon:${rec.id}:${input.decision}:${now.getTime()}`,
          occurredAt: now,
        },
      ]);
    }
    return { from: rec.status, to: input.decision };
  });
}

export function fileHash(buffer: Buffer): string {
  return sha256Hex(buffer);
}

export const SCENARIO_OPTIONS = Object.entries(SCENARIOS).map(([key, v]) => ({ key: key as ScenarioKey, ...v }));
