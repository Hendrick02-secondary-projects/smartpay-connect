import "server-only";
import type { Executor } from "@/lib/db";
import { lifecycleEvents, type LifecycleStage } from "@/lib/db/schema";

export interface LifecycleEventInput {
  organizationId: string;
  paymentIntentId: string;
  debitNoteId?: string | null;
  stage: LifecycleStage;
  eventType: string;
  actorType: "user" | "system" | "public" | "provider";
  actorUserId?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
  isSimulated?: boolean;
  /**
   * Natural key of the fact this event describes (e.g. `payment:<id>:successful`,
   * `settlement:<line id>`). Re-recording the same fact is a no-op, so retried
   * webhooks and re-run backfills never duplicate the timeline.
   */
  dedupeKey?: string | null;
  occurredAt?: Date;
}

/** Appends timeline events (idempotent per dedupeKey). Call inside the transaction that changes the fact. */
export async function recordEvents(db: Executor, events: readonly LifecycleEventInput[]): Promise<void> {
  if (events.length === 0) return;
  await db
    .insert(lifecycleEvents)
    .values(
      events.map((e) => ({
        organizationId: e.organizationId,
        paymentIntentId: e.paymentIntentId,
        debitNoteId: e.debitNoteId ?? null,
        stage: e.stage,
        eventType: e.eventType,
        actorType: e.actorType,
        actorUserId: e.actorUserId ?? null,
        summary: e.summary.slice(0, 300),
        metadata: e.metadata ?? {},
        isSimulated: e.isSimulated ?? true,
        dedupeKey: e.dedupeKey ?? null,
        occurredAt: e.occurredAt ?? new Date(),
      })),
    )
    .onConflictDoNothing({ target: lifecycleEvents.dedupeKey });
}

export const recordEvent = (db: Executor, e: LifecycleEventInput) => recordEvents(db, [e]);
