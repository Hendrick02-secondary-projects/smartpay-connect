import "server-only";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database, Executor } from "@/lib/db";
import {
  bankSettlements,
  commissionEntries,
  commissionInvoiceLines,
  commissionInvoices,
  commissionPayouts,
  kitAllocations,
  lifecycleEvents,
  paymentClosures,
  paymentIntents,
  reconciliationRecords,
  settlementBatches,
  users,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { HttpError } from "@/lib/http";
import { summarizeAllocations, type KitStatus } from "@/lib/kit/allocation";
import { recordEvents } from "./events";
import { canCloseFinancial, canCloseOperational, deriveStages, type LifecycleFacts, type Stage } from "./stages";

/**
 * Loads the facts for many payments with a fixed number of grouped queries
 * (not one query per payment), so list views stay cheap on serverless.
 */
export async function loadFactsMany(db: Executor, paymentIds: readonly string[]): Promise<Map<string, LifecycleFacts>> {
  const out = new Map<string, LifecycleFacts>();
  if (paymentIds.length === 0) return out;
  const ids = [...new Set(paymentIds)];

  const [payments, settlements, recon, allocations, closures, commission, confirmed] = await Promise.all([
    db
      .select({ id: paymentIntents.id, status: paymentIntents.status, createdAt: paymentIntents.createdAt, completedAt: paymentIntents.completedAt, statusChangedAt: paymentIntents.statusChangedAt, recon: paymentIntents.reconciliationStatus })
      .from(paymentIntents)
      .where(inArray(paymentIntents.id, ids)),
    db
      .select({
        id: paymentIntents.id,
        lines: sql<number>`count(${bankSettlements.id})::int`,
        firstAt: sql<Date | null>`min(${bankSettlements.createdAt})`,
        pending: sql<boolean>`coalesce(bool_or(${settlementBatches.reconciliationState} = 'pending'), false)`,
      })
      .from(paymentIntents)
      .innerJoin(
        bankSettlements,
        and(
          eq(bankSettlements.organizationId, paymentIntents.organizationId),
          eq(bankSettlements.paymentReference, paymentIntents.reference),
          eq(bankSettlements.movementType, "credit"),
          eq(bankSettlements.isDuplicateRow, false),
        ),
      )
      .innerJoin(settlementBatches, eq(settlementBatches.id, bankSettlements.batchId))
      .where(inArray(paymentIntents.id, ids))
      .groupBy(paymentIntents.id),
    db
      .select({ id: reconciliationRecords.paymentIntentId, at: sql<Date | null>`max(coalesce(${reconciliationRecords.reviewedAt}, ${reconciliationRecords.createdAt}))` })
      .from(reconciliationRecords)
      .where(inArray(reconciliationRecords.paymentIntentId, ids))
      .groupBy(reconciliationRecords.paymentIntentId),
    db
      .select({ id: kitAllocations.paymentIntentId, status: kitAllocations.status, updatedAt: kitAllocations.updatedAt })
      .from(kitAllocations)
      .where(inArray(kitAllocations.paymentIntentId, ids)),
    db
      .select({ id: paymentClosures.paymentIntentId, kind: paymentClosures.kind, closedAt: paymentClosures.closedAt })
      .from(paymentClosures)
      .where(and(inArray(paymentClosures.paymentIntentId, ids), isNull(paymentClosures.reopenedAt))),
    db
      .select({
        id: commissionEntries.paymentIntentId,
        entryType: commissionEntries.entryType,
        amountMinor: commissionEntries.amountMinor,
        createdAt: commissionEntries.createdAt,
        invoiceStatus: commissionInvoices.status,
        issuedAt: commissionInvoices.issuedAt,
        collectedAt: sql<Date | null>`(select max(${commissionPayouts.receivedAt}) from ${commissionPayouts} where ${commissionPayouts.invoiceId} = ${commissionInvoices.id})`,
      })
      .from(commissionEntries)
      .leftJoin(commissionInvoiceLines, eq(commissionInvoiceLines.commissionEntryId, commissionEntries.id))
      .leftJoin(commissionInvoices, eq(commissionInvoices.id, commissionInvoiceLines.invoiceId))
      .where(inArray(commissionEntries.paymentIntentId, ids)),
    db
      .select({ id: lifecycleEvents.paymentIntentId, at: sql<Date>`min(${lifecycleEvents.occurredAt})` })
      .from(lifecycleEvents)
      .where(and(inArray(lifecycleEvents.paymentIntentId, ids), eq(lifecycleEvents.eventType, "payment.successful")))
      .groupBy(lifecycleEvents.paymentIntentId),
  ]);

  const toDate = (v: Date | string | null | undefined) => (v ? new Date(v) : null);
  const maxDate = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a > b ? a : b);

  for (const p of payments) {
    const s = settlements.find((x) => x.id === p.id);
    const allocs = allocations.filter((x) => x.id === p.id);
    const entries = commission.filter((x) => x.id === p.id);
    const accrual = entries.find((e) => e.entryType === "accrual");
    let invoicedAt: Date | null = null;
    let collectedAt: Date | null = null;
    for (const e of entries) {
      invoicedAt = maxDate(invoicedAt, toDate(e.issuedAt));
      collectedAt = maxDate(collectedAt, toDate(e.collectedAt));
    }
    const confirmedEvent = confirmed.find((x) => x.id === p.id);
    const op = closures.find((c) => c.id === p.id && c.kind === "operational");
    const fin = closures.find((c) => c.id === p.id && c.kind === "financial");
    out.set(p.id, {
      payment: {
        status: p.status,
        createdAt: p.createdAt,
        confirmedAt: toDate(confirmedEvent?.at) ?? (p.status === "successful" || p.status === "reversed" ? p.completedAt : null),
        reversedAt: p.status === "reversed" ? p.statusChangedAt : null,
      },
      settlement: { lines: s?.lines ?? 0, firstAt: toDate(s?.firstAt), awaitingReconciliation: !!s?.pending },
      reconciliation: { state: p.recon, at: toDate(recon.find((r) => r.id === p.id)?.at) },
      allocations: {
        ...summarizeAllocations(allocs.map((a) => a.status as KitStatus)),
        lastAt: allocs.reduce<Date | null>((m, a) => maxDate(m, a.updatedAt), null),
      },
      operationalClosure: op ? { closedAt: op.closedAt } : null,
      commission: {
        entries: entries.length,
        accruedMinor: accrual?.amountMinor ?? 0,
        accruedAt: accrual?.createdAt ?? null,
        netMinor: entries.reduce((a, e) => a + e.amountMinor, 0),
        reversed: entries.some((e) => e.entryType === "reversal"),
        invoicedEntries: entries.filter((e) => e.invoiceStatus && e.invoiceStatus !== "void").length,
        invoicedAt,
        paidEntries: entries.filter((e) => e.invoiceStatus === "paid").length,
        partiallyPaid: entries.some((e) => e.invoiceStatus === "partially_paid"),
        collectedAt,
      },
      financialClosure: fin ? { closedAt: fin.closedAt } : null,
    });
  }
  return out;
}

export async function loadFacts(db: Executor, paymentId: string): Promise<LifecycleFacts | null> {
  return (await loadFactsMany(db, [paymentId])).get(paymentId) ?? null;
}

export const TENANT_STAGES = ["payment", "settlement", "reconciliation", "kit_allocation", "operational_closure"] as const;

/** Timeline of one payment. Tenants only see operational stages; the platform owner sees everything. */
export async function listTimeline(db: Executor, paymentId: string, audience: "tenant" | "platform") {
  return db
    .select({
      id: lifecycleEvents.id,
      stage: lifecycleEvents.stage,
      eventType: lifecycleEvents.eventType,
      actorType: lifecycleEvents.actorType,
      actorName: users.name,
      summary: lifecycleEvents.summary,
      metadata: lifecycleEvents.metadata,
      isSimulated: lifecycleEvents.isSimulated,
      occurredAt: lifecycleEvents.occurredAt,
    })
    .from(lifecycleEvents)
    .leftJoin(users, eq(users.id, lifecycleEvents.actorUserId))
    .where(
      and(
        eq(lifecycleEvents.paymentIntentId, paymentId),
        audience === "tenant" ? inArray(lifecycleEvents.stage, [...TENANT_STAGES]) : undefined,
      ),
    )
    .orderBy(asc(lifecycleEvents.occurredAt), asc(lifecycleEvents.createdAt));
}

export interface LifecycleView {
  facts: LifecycleFacts;
  stages: Stage[];
  canCloseOperational: ReturnType<typeof canCloseOperational>;
  canCloseFinancial: ReturnType<typeof canCloseFinancial>;
}

export async function getLifecycle(db: Executor, paymentId: string): Promise<LifecycleView | null> {
  const facts = await loadFacts(db, paymentId);
  if (!facts) return null;
  return { facts, stages: deriveStages(facts), canCloseOperational: canCloseOperational(facts), canCloseFinancial: canCloseFinancial(facts) };
}

type Kind = "operational" | "financial";
const KIND_TEXT: Record<Kind, { stage: "operational_closure" | "financial_closure"; closed: string; reopened: string }> = {
  operational: { stage: "operational_closure", closed: "Processo operacional da seguradora encerrado", reopened: "Encerramento operacional reaberto" },
  financial: { stage: "financial_closure", closed: "Processo financeiro SmartPay encerrado", reopened: "Encerramento financeiro reaberto" },
};

/**
 * Closes one side of the process. `organizationId` scopes tenant (operational) closures;
 * financial closures are platform-wide (organizationId = null).
 */
export async function closeProcess(
  db: Database,
  input: { kind: Kind; paymentIntentId: string; organizationId: string | null; notes?: string | null },
  actor: { userId: string },
  now: Date = new Date(),
) {
  return db.transaction(async (tx) => {
    const [p] = await tx
      .select()
      .from(paymentIntents)
      .where(and(eq(paymentIntents.id, input.paymentIntentId), input.organizationId ? eq(paymentIntents.organizationId, input.organizationId) : undefined))
      .limit(1)
      .for("update");
    if (!p) throw new HttpError(404, "not_found", "Transacção não encontrada.");
    const facts = await loadFacts(tx, p.id);
    const check = input.kind === "operational" ? canCloseOperational(facts!) : canCloseFinancial(facts!);
    if (!check.ok) throw new HttpError(422, "cannot_close", check.reasons.join(" "), check.reasons);
    const notes = input.notes?.trim() || null;
    if (notes && notes.length > 500) throw new HttpError(422, "notes_too_long", "Observações demasiado longas (máx. 500).");
    const [closure] = await tx
      .insert(paymentClosures)
      .values({ organizationId: p.organizationId, paymentIntentId: p.id, kind: input.kind, closedBy: actor.userId, notes, closedAt: now })
      .returning();
    await recordEvents(tx, [
      {
        organizationId: p.organizationId,
        paymentIntentId: p.id,
        stage: KIND_TEXT[input.kind].stage,
        eventType: `${input.kind}.closed`,
        actorType: "user",
        actorUserId: actor.userId,
        summary: KIND_TEXT[input.kind].closed + (notes ? ` — ${notes}` : ""),
        isSimulated: p.isSimulated,
        dedupeKey: `closure:${closure!.id}`,
        occurredAt: now,
      },
    ]);
    await writeAudit(tx, {
      organizationId: p.organizationId,
      actorType: "user",
      actorUserId: actor.userId,
      action: `closure.${input.kind}_closed`,
      entityType: "payment_intent",
      entityId: p.id,
      metadata: { reference: p.reference, notes },
    });
    return closure!;
  });
}

export async function reopenProcess(
  db: Database,
  input: { kind: Kind; paymentIntentId: string; organizationId: string | null; reason: string },
  actor: { userId: string | null },
  now: Date = new Date(),
) {
  return db.transaction((tx) => reopenInTx(tx, input, actor, now));
}

/** Also used by the reversal pipeline (actor = system). */
export async function reopenInTx(
  tx: Executor,
  input: { kind: Kind; paymentIntentId: string; organizationId: string | null; reason: string },
  actor: { userId: string | null },
  now: Date = new Date(),
): Promise<boolean> {
  const reason = input.reason.trim();
  if (reason.length < 10) throw new HttpError(422, "reason_required", "Indique o motivo da reabertura (mín. 10 caracteres).");
  const [open] = await tx
    .select({ c: paymentClosures, isSimulated: paymentIntents.isSimulated })
    .from(paymentClosures)
    .innerJoin(paymentIntents, eq(paymentIntents.id, paymentClosures.paymentIntentId))
    .where(
      and(
        eq(paymentClosures.paymentIntentId, input.paymentIntentId),
        eq(paymentClosures.kind, input.kind),
        isNull(paymentClosures.reopenedAt),
        input.organizationId ? eq(paymentClosures.organizationId, input.organizationId) : undefined,
      ),
    )
    .limit(1)
    .for("update", { of: paymentClosures });
  if (!open) {
    if (actor.userId) throw new HttpError(409, "not_closed", "A transacção não está encerrada.");
    return false;
  }
  await tx.update(paymentClosures).set({ reopenedAt: now, reopenedBy: actor.userId, reopenReason: reason }).where(eq(paymentClosures.id, open.c.id));
  await recordEvents(tx, [
    {
      organizationId: open.c.organizationId,
      paymentIntentId: input.paymentIntentId,
      stage: KIND_TEXT[input.kind].stage,
      eventType: `${input.kind}.reopened`,
      actorType: actor.userId ? "user" : "system",
      actorUserId: actor.userId,
      summary: `${KIND_TEXT[input.kind].reopened} — ${reason}`,
      isSimulated: open.isSimulated,
      dedupeKey: `closure:${open.c.id}:reopened`,
      occurredAt: now,
    },
  ]);
  await writeAudit(tx, {
    organizationId: open.c.organizationId,
    actorType: actor.userId ? "user" : "system",
    actorUserId: actor.userId,
    action: `closure.${input.kind}_reopened`,
    entityType: "payment_intent",
    entityId: input.paymentIntentId,
    metadata: { reason },
  });
  return true;
}
