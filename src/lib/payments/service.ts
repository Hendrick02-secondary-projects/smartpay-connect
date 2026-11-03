import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import {
  bankAccounts,
  organizations,
  paymentDebitNotes,
  paymentEvents,
  paymentIntents,
  paymentTransactions,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { accrueCommission, reverseCommission } from "@/lib/commission/service";
import { openAllocations, voidUnallocatedOnReversal } from "@/lib/kit/service";
import { recordEvents } from "@/lib/lifecycle/events";
import { reopenInTx } from "@/lib/lifecycle/service";
import { HttpError } from "@/lib/http";
import { debitNotesTotal, generatePaymentReference, PAYMENT_REFERENCE_PREFIX } from "@/lib/payments/rules";
import { consumeRateLimit } from "@/lib/rate-limit";
import { randomBytesArray, randomToken, safeEqualHex, sha256Hex } from "@/lib/security/crypto";
import type { CreatePaymentInput } from "@/lib/validation/payment";
import type { MockPaymentProvider, MockScenario, PendingResolution } from "./mock-provider";
import { scenarioFromTestPhone } from "./mock-provider";
import type { PaymentProvider, SignedWebhook } from "./provider";
import { decideTransition, type PaymentStatusValue } from "./state-machine";

export interface PublicContext {
  ipHash: string | null;
}

/** Canonical hash of the business content of a request — used to detect idempotency-key reuse with different data. */
export function requestFingerprint(input: CreatePaymentInput): string {
  return sha256Hex(
    JSON.stringify({
      a: input.bankAccountCode,
      n: input.customerName,
      p: input.customerPhone,
      m: input.method,
      d: input.debitNotes.map((d) => [d.number, d.amount]),
    }),
  );
}

/**
 * Creates a payment intent for a tenant's public portal.
 * - Idempotent on (organization, idempotencyKey): replays return the same intent.
 * - Reusing a key with DIFFERENT data is rejected (409).
 */
export async function createPaymentIntent(
  db: Database,
  provider: PaymentProvider,
  orgSlug: string,
  input: CreatePaymentInput,
  ctx: PublicContext,
  now: Date = new Date(),
): Promise<{ reference: string; clientSecret: string | null; replayed: boolean; status: PaymentStatusValue }> {
  const limit = await consumeRateLimit(db, `pay:create:${ctx.ipHash ?? "unknown"}`, 15, 10 * 60);
  if (!limit.allowed) throw new HttpError(429, "rate_limited", "Demasiados pedidos. Aguarde alguns minutos.");

  const [org] = await db
    .select({ id: organizations.id, isActive: organizations.isActive })
    .from(organizations)
    .where(eq(organizations.slug, orgSlug))
    .limit(1);
  if (!org || !org.isActive) throw new HttpError(404, "not_found", "Portal de pagamento não encontrado.");

  const [account] = await db
    .select({ id: bankAccounts.id })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.organizationId, org.id), eq(bankAccounts.code, input.bankAccountCode), eq(bankAccounts.isActive, true)))
    .limit(1);
  if (!account) throw new HttpError(422, "invalid_account", "Conta de destino inválida.");

  const fingerprint = requestFingerprint(input);
  const amountMinor = debitNotesTotal(input.debitNotes.map((d) => ({ number: d.number, amountMinor: d.amount })));
  const reference = generatePaymentReference(PAYMENT_REFERENCE_PREFIX, now, randomBytesArray(8));
  const clientSecret = randomToken(24);
  const created = await provider.createPayment({
    reference,
    amountMinor,
    currency: "MZN",
    method: input.method,
    customerPhone: input.customerPhone,
  });

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(paymentIntents)
      .values({
        organizationId: org.id,
        reference,
        idempotencyKey: input.idempotencyKey,
        requestHash: fingerprint,
        clientSecretHash: sha256Hex(clientSecret),
        bankAccountId: account.id,
        customerName: input.customerName,
        customerPhone: input.customerPhone,
        paymentMethod: input.method,
        amountMinor,
        provider: provider.name,
        providerReference: created.providerReference,
        isSimulated: provider.isSimulated,
      })
      .onConflictDoNothing({ target: [paymentIntents.organizationId, paymentIntents.idempotencyKey] })
      .returning({ id: paymentIntents.id });

    if (inserted.length === 0) {
      const [existing] = await tx
        .select({ reference: paymentIntents.reference, requestHash: paymentIntents.requestHash, status: paymentIntents.status })
        .from(paymentIntents)
        .where(and(eq(paymentIntents.organizationId, org.id), eq(paymentIntents.idempotencyKey, input.idempotencyKey)))
        .limit(1);
      if (!existing) throw new HttpError(409, "conflict", "Conflito ao criar pagamento. Tente novamente.");
      if (existing.requestHash !== fingerprint) {
        throw new HttpError(409, "idempotency_conflict", "Esta chave de pedido já foi usada com dados diferentes.");
      }
      // The secret is never stored in clear text, so a replay cannot return it;
      // the client keeps the secret it received on the first response.
      return { reference: existing.reference, clientSecret: null, replayed: true, status: existing.status };
    }

    const intentId = inserted[0]!.id;
    await tx.insert(paymentDebitNotes).values(
      input.debitNotes.map((d, i) => ({
        organizationId: org.id,
        paymentIntentId: intentId,
        debitNoteNumber: d.number,
        amountMinor: d.amount,
        position: i + 1,
      })),
    );
    await writeAudit(tx, {
      organizationId: org.id,
      actorType: "public",
      action: "payment.intent_created",
      entityType: "payment_intent",
      entityId: intentId,
      metadata: { reference, amountMinor, method: input.method, debitNotes: input.debitNotes.length, simulated: provider.isSimulated },
      ipHash: ctx.ipHash,
    });
    await recordEvents(tx, [
      {
        organizationId: org.id,
        paymentIntentId: intentId,
        stage: "payment",
        eventType: "payment.created",
        actorType: "public",
        summary: `Pagamento iniciado pelo cliente (${input.method}, ${input.debitNotes.length} nota(s) de débito)`,
        metadata: { amountMinor, method: input.method },
        isSimulated: provider.isSimulated,
        dedupeKey: `payment:${intentId}:created`,
        occurredAt: now,
      },
    ]);
    return { reference, clientSecret, replayed: false, status: "created" as const };
  });
}

export type EventOutcome =
  | { result: "processed"; from: PaymentStatusValue; to: PaymentStatusValue }
  | { result: "duplicate" }
  | { result: "ignored"; note: string }
  | { result: "rejected"; reason: string };

/**
 * The webhook pipeline (used for real HTTP webhooks AND for in-process simulated
 * events, so both follow exactly the same rules):
 *   1. signature verification   2. event deduplication (unique provider+event_id)
 *   3. amount / currency check   4. state-machine validation
 *   5. atomic side effects: status, transaction row, commission accrual/reversal, audit
 */
export async function processProviderWebhook(db: Database, provider: PaymentProvider, rawBody: string, headers: Headers): Promise<EventOutcome> {
  const verification = provider.verifyWebhook(rawBody, headers);
  if (!verification.valid) {
    // Unverified payloads are logged under a random id so they can never "reserve"
    // a legitimate event id and block the real delivery.
    await db.insert(paymentEvents).values({
      provider: provider.name,
      eventId: `unverified:${randomToken(12)}`,
      eventType: "unverified",
      signatureValid: false,
      processingStatus: "rejected",
      processingNote: verification.reason,
      payload: { reason: verification.reason, bytes: rawBody.length },
      processedAt: new Date(),
    });
    return { result: "rejected", reason: verification.reason };
  }
  const event = verification.event;

  return db.transaction(async (tx) => {
    const [intent] = await tx
      .select()
      .from(paymentIntents)
      .where(and(eq(paymentIntents.provider, provider.name), eq(paymentIntents.providerReference, event.providerReference)))
      .limit(1)
      .for("update");

    const logged = await tx
      .insert(paymentEvents)
      .values({
        organizationId: intent?.organizationId ?? null,
        paymentIntentId: intent?.id ?? null,
        provider: provider.name,
        eventId: event.eventId,
        eventType: event.eventType,
        fromStatus: intent?.status ?? null,
        toStatus: event.status,
        signatureValid: true,
        processingStatus: "received",
        payload: verification.raw as Record<string, unknown>,
      })
      .onConflictDoNothing({ target: [paymentEvents.provider, paymentEvents.eventId] })
      .returning({ id: paymentEvents.id });
    if (logged.length === 0) return { result: "duplicate" } as const;
    const eventRowId = logged[0]!.id;

    const finish = async (status: "processed" | "ignored", note: string | null) => {
      await tx
        .update(paymentEvents)
        .set({ processingStatus: status, processingNote: note, processedAt: new Date() })
        .where(eq(paymentEvents.id, eventRowId));
    };

    if (!intent) {
      await finish("ignored", "unknown_provider_reference");
      return { result: "ignored", note: "unknown_provider_reference" } as const;
    }
    if (event.paymentReference !== intent.reference || event.amountMinor !== intent.amountMinor || event.currency !== intent.currency) {
      await finish("ignored", "payload_mismatch");
      await writeAudit(tx, {
        organizationId: intent.organizationId,
        actorType: "provider",
        action: "payment.event_payload_mismatch",
        entityType: "payment_intent",
        entityId: intent.id,
        metadata: { eventId: event.eventId },
      });
      return { result: "ignored", note: "payload_mismatch" } as const;
    }

    const decision = decideTransition(intent.status, event.status);
    if (decision.kind !== "apply") {
      const note = decision.kind === "noop" ? "already_in_state" : `invalid_transition:${intent.status}->${event.status}`;
      await finish("ignored", note);
      return { result: "ignored", note } as const;
    }

    const now = new Date();
    const terminal = ["successful", "failed", "cancelled", "reversed"].includes(event.status);
    await tx
      .update(paymentIntents)
      .set({
        status: event.status,
        statusChangedAt: now,
        completedAt: terminal ? now : intent.completedAt,
        failureReason: event.failureReason,
      })
      .where(eq(paymentIntents.id, intent.id));

    if (event.status === "successful") {
      await tx
        .insert(paymentTransactions)
        .values({
          organizationId: intent.organizationId,
          paymentIntentId: intent.id,
          type: "charge",
          providerTransactionId: event.providerTransactionId ?? `${event.eventId}:charge`,
          amountMinor: intent.amountMinor,
          gatewayFeeMinor: event.gatewayFeeMinor,
          paymentMethod: intent.paymentMethod,
          isSimulated: provider.isSimulated,
          processedAt: new Date(event.occurredAt),
        })
        .onConflictDoNothing();
      await accrueCommission(tx, { id: intent.id, organizationId: intent.organizationId, amountMinor: intent.amountMinor, isSimulated: intent.isSimulated }, now);
      await openAllocations(tx, { id: intent.id, organizationId: intent.organizationId, isSimulated: intent.isSimulated }, now);
    }

    if (event.status === "reversed") {
      await tx
        .insert(paymentTransactions)
        .values({
          organizationId: intent.organizationId,
          paymentIntentId: intent.id,
          type: "reversal",
          providerTransactionId: event.providerTransactionId ?? `${event.eventId}:reversal`,
          amountMinor: intent.amountMinor,
          paymentMethod: intent.paymentMethod,
          isSimulated: provider.isSimulated,
          processedAt: new Date(event.occurredAt),
        })
        .onConflictDoNothing();
      await reverseCommission(
        tx,
        { id: intent.id, organizationId: intent.organizationId, isSimulated: intent.isSimulated },
        `Reversão do pagamento ${intent.reference}: ${event.failureReason ?? "sem motivo"}`,
        now,
      );
      // A reversal re-opens whatever was closed: the KIT allocation must be annulled and the
      // commission credited, so neither process can stay "closed" on stale facts.
      const why = `Pagamento revertido pelo fornecedor (simulado): ${event.failureReason ?? "sem motivo"}`;
      await reopenInTx(tx, { kind: "operational", paymentIntentId: intent.id, organizationId: intent.organizationId, reason: why }, { userId: null }, now);
      await reopenInTx(tx, { kind: "financial", paymentIntentId: intent.id, organizationId: intent.organizationId, reason: why }, { userId: null }, now);
      await voidUnallocatedOnReversal(tx, { id: intent.id, organizationId: intent.organizationId, reference: intent.reference }, now);
    }

    const STATUS_TEXT: Record<string, string> = {
      pending: "Fornecedor (simulado) recebeu o pedido de pagamento",
      successful: "Pagamento confirmado pelo fornecedor (simulado)",
      failed: "Pagamento recusado pelo fornecedor (simulado)",
      cancelled: "Pagamento cancelado (simulado)",
      reversed: "Pagamento revertido pelo fornecedor (simulado)",
    };
    await recordEvents(tx, [
      {
        organizationId: intent.organizationId,
        paymentIntentId: intent.id,
        stage: "payment",
        eventType: `payment.${event.status}`,
        actorType: "provider",
        summary: (STATUS_TEXT[event.status] ?? `Estado: ${event.status}`) + (event.failureReason ? ` — ${event.failureReason}` : ""),
        metadata: { eventId: event.eventId, from: intent.status, gatewayFeeMinor: event.gatewayFeeMinor },
        isSimulated: provider.isSimulated,
        dedupeKey: `payment:${intent.id}:${event.status}`,
        occurredAt: now,
      },
    ]);
    await writeAudit(tx, {
      organizationId: intent.organizationId,
      actorType: "provider",
      action: `payment.status_${event.status}`,
      entityType: "payment_intent",
      entityId: intent.id,
      metadata: { from: intent.status, to: event.status, eventId: event.eventId, simulated: provider.isSimulated },
    });
    await finish("processed", null);
    return { result: "processed", from: intent.status, to: event.status } as const;
  });
}

async function deliver(db: Database, provider: PaymentProvider, hooks: SignedWebhook[]): Promise<EventOutcome[]> {
  const outcomes: EventOutcome[] = [];
  for (const hook of hooks) {
    outcomes.push(await processProviderWebhook(db, provider, hook.rawBody, new Headers(hook.headers)));
  }
  return outcomes;
}

async function loadIntentForCustomer(db: Database, orgSlug: string, reference: string, clientSecret: string) {
  const [row] = await db
    .select({ intent: paymentIntents })
    .from(paymentIntents)
    .innerJoin(organizations, eq(organizations.id, paymentIntents.organizationId))
    .where(and(eq(organizations.slug, orgSlug), eq(paymentIntents.reference, reference)))
    .limit(1);
  // Same error for "not found" and "wrong secret": no reference enumeration.
  if (!row || !safeEqualHex(row.intent.clientSecretHash, sha256Hex(clientSecret))) {
    throw new HttpError(404, "not_found", "Pagamento não encontrado.");
  }
  return row.intent;
}

/** Customer confirms the SIMULATED checkout. Card data is never requested or accepted. */
export async function authorizeSimulatedPayment(
  db: Database,
  provider: MockPaymentProvider,
  orgSlug: string,
  reference: string,
  clientSecret: string,
  chosenScenario: MockScenario,
) {
  const intent = await loadIntentForCustomer(db, orgSlug, reference, clientSecret);
  return runSimulatedCheckout(db, provider, intent, chosenScenario);
}

type IntentRow = typeof paymentIntents.$inferSelect;

/** Shared by the customer checkout and the Demo Control Center (no client secret there: owner-only). */
export async function runSimulatedCheckout(db: Database, provider: MockPaymentProvider, intent: IntentRow, chosenScenario: MockScenario) {
  if (intent.status !== "created" && intent.status !== "pending") {
    return { status: intent.status, scenario: intent.simulationScenario, outcomes: [] as EventOutcome[] };
  }
  const scenario = scenarioFromTestPhone(intent.paymentMethod, intent.customerPhone) ?? chosenScenario;
  if (intent.status === "created") {
    await db.update(paymentIntents).set({ simulationScenario: scenario }).where(eq(paymentIntents.id, intent.id));
  }
  const hooks = provider.simulateCheckout({
    reference: intent.reference,
    providerReference: intent.providerReference!,
    amountMinor: intent.amountMinor,
    method: intent.paymentMethod,
    scenario,
  });
  const outcomes = await deliver(db, provider, hooks);
  const [after] = await db.select({ status: paymentIntents.status }).from(paymentIntents).where(eq(paymentIntents.id, intent.id));
  return { status: after!.status, scenario, outcomes };
}

/** Simulates the provider's final callback for a payment left pending. */
export async function resolvePendingPayment(
  db: Database,
  provider: MockPaymentProvider,
  orgSlug: string,
  reference: string,
  clientSecret: string,
  resolution: PendingResolution,
) {
  const intent = await loadIntentForCustomer(db, orgSlug, reference, clientSecret);
  return runPendingResolution(db, provider, intent, resolution);
}

export async function runPendingResolution(db: Database, provider: MockPaymentProvider, intent: IntentRow, resolution: PendingResolution) {
  if (intent.status !== "pending") throw new HttpError(409, "not_pending", "Este pagamento já não está pendente.");
  const hook = provider.resolvePending(
    { reference: intent.reference, providerReference: intent.providerReference!, amountMinor: intent.amountMinor, method: intent.paymentMethod },
    resolution,
  );
  const [outcome] = await deliver(db, provider, [hook]);
  const [after] = await db.select({ status: paymentIntents.status }).from(paymentIntents).where(eq(paymentIntents.id, intent.id));
  return { status: after!.status, outcome };
}

/** Public, capability-protected view used by the status page and demo confirmation. */
export async function getCustomerPaymentView(db: Database, orgSlug: string, reference: string, clientSecret: string) {
  const intent = await loadIntentForCustomer(db, orgSlug, reference, clientSecret);
  const [account] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, intent.bankAccountId));
  const notes = await db
    .select({ number: paymentDebitNotes.debitNoteNumber, amountMinor: paymentDebitNotes.amountMinor })
    .from(paymentDebitNotes)
    .where(eq(paymentDebitNotes.paymentIntentId, intent.id))
    .orderBy(asc(paymentDebitNotes.position));
  return {
    reference: intent.reference,
    status: intent.status,
    customerName: intent.customerName,
    customerPhone: intent.customerPhone,
    method: intent.paymentMethod,
    amountMinor: intent.amountMinor,
    currency: intent.currency,
    createdAt: intent.createdAt,
    completedAt: intent.completedAt,
    failureReason: intent.failureReason,
    scenario: intent.simulationScenario,
    isSimulated: intent.isSimulated,
    account: account ? { bankName: account.bankName, accountName: account.accountName, accountNumberMasked: account.accountNumberMasked } : null,
    debitNotes: notes,
  };
}

/** Platform owner (demo control): ask the simulated provider to reverse a successful payment. */
export async function reverseSimulatedPayment(
  db: Database,
  provider: MockPaymentProvider,
  paymentIntentId: string,
  reason: string,
  actorUserId: string,
) {
  if (reason.trim().length < 10) throw new HttpError(422, "reason_required", "Indique um motivo (mín. 10 caracteres).");
  const [intent] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, paymentIntentId)).limit(1);
  if (!intent) throw new HttpError(404, "not_found", "Pagamento não encontrado.");
  if (intent.status !== "successful") throw new HttpError(409, "not_reversible", "Só pagamentos bem-sucedidos podem ser revertidos.");
  const refund = await provider.refundPayment({
    providerReference: intent.providerReference!,
    paymentReference: intent.reference,
    amountMinor: intent.amountMinor,
    reason: reason.trim(),
  });
  if (!refund.accepted || !refund.signedEvent) throw new HttpError(502, "provider_rejected", "O fornecedor simulado recusou a reversão.");
  await writeAudit(db, {
    organizationId: intent.organizationId,
    actorType: "user",
    actorUserId,
    action: "payment.reversal_requested",
    entityType: "payment_intent",
    entityId: intent.id,
    metadata: { reason: reason.trim(), simulated: true },
  });
  const [outcome] = await deliver(db, provider, [refund.signedEvent]);
  return outcome;
}

/** Lightweight count used by health/readiness checks. */
export async function countEvents(db: Database): Promise<number> {
  const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(paymentEvents);
  return row?.c ?? 0;
}
