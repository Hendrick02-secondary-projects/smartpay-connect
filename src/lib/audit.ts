import "server-only";
import type { Executor } from "@/lib/db";
import { auditLogs } from "@/lib/db/schema";

export interface AuditInput {
  organizationId: string | null;
  actorType: "user" | "system" | "public" | "provider";
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  ipHash?: string | null;
}

const SENSITIVE_KEYS = /pass|secret|token|cvv|pan|card_?number|authorization/i;

/** Strips anything that looks sensitive before it reaches the append-only audit log. */
function redact(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    out[k] = SENSITIVE_KEYS.test(k) ? "[REDACTED]" : v;
  }
  return out;
}

export async function writeAudit(db: Executor, input: AuditInput): Promise<void> {
  await db.insert(auditLogs).values({
    organizationId: input.organizationId,
    actorType: input.actorType,
    actorUserId: input.actorUserId ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    metadata: redact(input.metadata ?? {}),
    ipHash: input.ipHash ?? null,
  });
}
