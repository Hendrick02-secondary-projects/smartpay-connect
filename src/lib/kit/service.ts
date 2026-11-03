import "server-only";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { Database, Executor } from "@/lib/db";
import { kitAllocations, paymentClosures, paymentDebitNotes, paymentIntents } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { HttpError } from "@/lib/http";
import { recordEvents, type LifecycleEventInput } from "@/lib/lifecycle/events";
import { ALLOCATION_ERROR_MESSAGES, decideAllocation, summarizeAllocations, type KitAction, type KitStatus } from "./allocation";

type Actor = { userId: string };

/** Maputo calendar date (YYYY-MM-DD) for an instant. */
export function maputoDate(d: Date): string {
  return new Date(d.getTime() + 2 * 3600_000).toISOString().slice(0, 10);
}

/**
 * Opens one pending allocation per debit note when a payment becomes successful.
 * Idempotent (unique debit_note_id). Runs inside the webhook transaction.
 */
export async function openAllocations(tx: Executor, payment: { id: string; organizationId: string; isSimulated: boolean }, at: Date) {
  const notes = await tx
    .select({ id: paymentDebitNotes.id })
    .from(paymentDebitNotes)
    .where(eq(paymentDebitNotes.paymentIntentId, payment.id));
  if (notes.length === 0) return;
  await tx
    .insert(kitAllocations)
    .values(notes.map((n) => ({ organizationId: payment.organizationId, paymentIntentId: payment.id, debitNoteId: n.id, createdAt: at, updatedAt: at })))
    .onConflictDoNothing({ target: kitAllocations.debitNoteId });
  await recordEvents(tx, [
    {
      organizationId: payment.organizationId,
      paymentIntentId: payment.id,
      stage: "kit_allocation",
      eventType: "kit.opened",
      actorType: "system",
      summary: `${notes.length} nota(s) de débito por alocar no KIT`,
      metadata: { debitNotes: notes.length },
      isSimulated: payment.isSimulated,
      dedupeKey: `kit:${payment.id}:opened`,
      occurredAt: at,
    },
  ]);
}

/**
 * Reversal handling: pending/issue allocations are annulled automatically (nothing was
 * booked in KIT); allocated ones stay "allocated" and are shown as needing a manual KIT
 * annulment by the Finance team. Must run AFTER any operational closure was reopened.
 */
export async function voidUnallocatedOnReversal(tx: Executor, payment: { id: string; organizationId: string; reference: string }, at: Date) {
  const rows = await tx
    .select({ a: kitAllocations, number: paymentDebitNotes.debitNoteNumber })
    .from(kitAllocations)
    .innerJoin(paymentDebitNotes, eq(paymentDebitNotes.id, kitAllocations.debitNoteId))
    .where(and(eq(kitAllocations.paymentIntentId, payment.id), sql`${kitAllocations.status} in ('pending','issue')`))
    .for("update", { of: kitAllocations });
  const events: LifecycleEventInput[] = [];
  for (const { a, number } of rows) {
    const version = a.version + 1;
    await tx
      .update(kitAllocations)
      .set({ status: "voided", notes: `Pagamento ${payment.reference} revertido antes da alocação no KIT.`, updatedBy: null, version })
      .where(eq(kitAllocations.id, a.id));
    events.push({
      organizationId: payment.organizationId,
      paymentIntentId: payment.id,
      debitNoteId: a.debitNoteId,
      stage: "kit_allocation",
      eventType: "kit.voided",
      actorType: "system",
      summary: `ND ${number} anulada automaticamente (pagamento revertido antes da alocação)`,
      dedupeKey: `kit:${a.id}:v${version}`,
      occurredAt: at,
    });
  }
  await recordEvents(tx, events);
}

export interface ChangeAllocationInput {
  organizationId: string;
  allocationId: string;
  action: KitAction;
  expectedVersion: number;
  receiptReference?: string | null;
  allocatedOn?: string | null;
  notes?: string | null;
}

const EVENT_TEXT: Record<KitAction, (nd: string, receipt: string | null) => string> = {
  allocate: (nd, r) => `ND ${nd} alocada no KIT — recibo ${r}`,
  flag_issue: (nd) => `Problema assinalado na alocação da ND ${nd}`,
  reset: (nd) => `Alocação da ND ${nd} anulada — volta a "por alocar"`,
  void: (nd) => `ND ${nd} anulada no KIT (pagamento revertido)`,
};

/**
 * Changes ONE debit note's KIT allocation. Tenant-scoped, optimistic-locked
 * (expectedVersion), validated by the pure rules and again by the DB trigger.
 */
export async function changeAllocation(db: Database, input: ChangeAllocationInput, actor: Actor, now: Date = new Date()) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ a: kitAllocations, p: paymentIntents, number: paymentDebitNotes.debitNoteNumber })
      .from(kitAllocations)
      .innerJoin(paymentIntents, eq(paymentIntents.id, kitAllocations.paymentIntentId))
      .innerJoin(paymentDebitNotes, eq(paymentDebitNotes.id, kitAllocations.debitNoteId))
      .where(and(eq(kitAllocations.id, input.allocationId), eq(kitAllocations.organizationId, input.organizationId)))
      .limit(1)
      .for("update", { of: kitAllocations });
    // Same answer for "missing" and "other tenant": no cross-tenant probing.
    if (!row) throw new HttpError(404, "not_found", "Nota de débito não encontrada.");
    const { a, p } = row;
    if (a.version !== input.expectedVersion) {
      throw new HttpError(409, "version_conflict", "Esta nota de débito foi alterada por outro utilizador. Actualize a página e tente novamente.");
    }
    const [closure] = await tx
      .select({ id: paymentClosures.id })
      .from(paymentClosures)
      .where(and(eq(paymentClosures.paymentIntentId, p.id), eq(paymentClosures.kind, "operational"), sql`${paymentClosures.reopenedAt} is null`))
      .limit(1);

    const decision = decideAllocation(
      a.status as KitStatus,
      input.action,
      {
        paymentStatus: p.status,
        reconciliationStatus: p.reconciliationStatus,
        operationallyClosed: !!closure,
        paymentDate: maputoDate(p.createdAt),
        today: maputoDate(now),
      },
      { receiptReference: input.receiptReference, allocatedOn: input.allocatedOn, notes: input.notes },
    );
    if (!decision.ok) throw new HttpError(422, decision.error, ALLOCATION_ERROR_MESSAGES[decision.error]);

    if (decision.next === "allocated" && decision.receiptReference) {
      const [reused] = await tx
        .select({ ref: paymentIntents.reference })
        .from(kitAllocations)
        .innerJoin(paymentIntents, eq(paymentIntents.id, kitAllocations.paymentIntentId))
        .where(
          and(
            eq(kitAllocations.organizationId, input.organizationId),
            eq(kitAllocations.receiptReference, decision.receiptReference),
            eq(kitAllocations.status, "allocated"),
            ne(kitAllocations.paymentIntentId, p.id),
          ),
        )
        .limit(1);
      if (reused) throw new HttpError(409, "receipt_in_use", `O recibo ${decision.receiptReference} já está associado à transacção ${reused.ref}.`);
    }

    const version = a.version + 1;
    const allocating = decision.next === "allocated";
    const [updated] = await tx
      .update(kitAllocations)
      .set({
        status: decision.next,
        receiptReference: allocating || decision.next === "voided" ? decision.receiptReference ?? a.receiptReference : null,
        allocatedOn: allocating ? decision.allocatedOn : decision.next === "voided" ? a.allocatedOn : null,
        allocatedBy: allocating ? actor.userId : decision.next === "voided" ? a.allocatedBy : null,
        notes: decision.notes,
        updatedBy: actor.userId,
        version,
      })
      .where(and(eq(kitAllocations.id, a.id), eq(kitAllocations.version, a.version)))
      .returning();
    if (!updated) throw new HttpError(409, "version_conflict", "Esta nota de débito foi alterada por outro utilizador. Actualize a página e tente novamente.");

    const events: LifecycleEventInput[] = [
      {
        organizationId: p.organizationId,
        paymentIntentId: p.id,
        debitNoteId: a.debitNoteId,
        stage: "kit_allocation",
        eventType: `kit.${input.action === "flag_issue" ? "issue" : input.action === "allocate" ? "allocated" : input.action === "reset" ? "reset" : "voided"}`,
        actorType: "user",
        actorUserId: actor.userId,
        summary: EVENT_TEXT[input.action](row.number, decision.receiptReference),
        metadata: { from: a.status, to: decision.next, receiptReference: decision.receiptReference, allocatedOn: decision.allocatedOn, notes: decision.notes, previousReceipt: a.receiptReference },
        isSimulated: p.isSimulated,
        dedupeKey: `kit:${a.id}:v${version}`,
        occurredAt: now,
      },
    ];
    const siblings = await tx.select({ status: kitAllocations.status }).from(kitAllocations).where(eq(kitAllocations.paymentIntentId, p.id));
    const summary = summarizeAllocations(siblings.map((s) => s.status));
    if (summary.state === "complete" && allocating) {
      events.push({
        organizationId: p.organizationId,
        paymentIntentId: p.id,
        stage: "kit_allocation",
        eventType: "kit.completed",
        actorType: "user",
        actorUserId: actor.userId,
        summary: `Todas as ${summary.total} notas de débito alocadas no KIT`,
        isSimulated: p.isSimulated,
        occurredAt: now,
      });
    }
    await recordEvents(tx, events);
    await writeAudit(tx, {
      organizationId: p.organizationId,
      actorType: "user",
      actorUserId: actor.userId,
      action: `kit.${input.action}`,
      entityType: "kit_allocation",
      entityId: a.id,
      metadata: { paymentReference: p.reference, debitNote: row.number, from: a.status, to: decision.next, receiptReference: decision.receiptReference, version },
    });
    return { allocation: updated, summary };
  });
}

/** Allocations of one payment, in debit-note order. */
export async function listPaymentAllocations(db: Executor, paymentIntentId: string) {
  return db
    .select({
      id: kitAllocations.id,
      status: kitAllocations.status,
      receiptReference: kitAllocations.receiptReference,
      allocatedOn: kitAllocations.allocatedOn,
      allocatedBy: kitAllocations.allocatedBy,
      notes: kitAllocations.notes,
      version: kitAllocations.version,
      updatedAt: kitAllocations.updatedAt,
      debitNoteId: paymentDebitNotes.id,
      debitNoteNumber: paymentDebitNotes.debitNoteNumber,
      amountMinor: paymentDebitNotes.amountMinor,
    })
    .from(kitAllocations)
    .innerJoin(paymentDebitNotes, eq(paymentDebitNotes.id, kitAllocations.debitNoteId))
    .where(eq(kitAllocations.paymentIntentId, paymentIntentId))
    .orderBy(asc(paymentDebitNotes.position));
}
