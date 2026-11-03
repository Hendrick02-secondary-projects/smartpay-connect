import "server-only";
import { and, asc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import type { Database, Executor, Tx } from "@/lib/db";
import {
  commissionEntries,
  commissionInvoiceLines,
  commissionInvoices,
  commissionPayouts,
  commissionRules,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { HttpError } from "@/lib/http";
import { recordEvents, type LifecycleEventInput } from "@/lib/lifecycle/events";
import { formatMzn, ppmToPercentString } from "@/lib/money";
import { computeAccrual, computeReversalAmount, invoiceStatusFor, selectApplicableRule, validateNewRule } from "./engine";

type Actor = { userId: string | null };

/**
 * Accrues commission for a payment that has just become eligible (successful).
 * Must run inside the same transaction as the status change. Idempotent: the
 * partial unique index `ce_one_accrual_per_payment` makes a second accrual impossible.
 */
export async function accrueCommission(
  tx: Tx,
  payment: { id: string; organizationId: string; amountMinor: number; isSimulated?: boolean },
  eligibleAt: Date,
): Promise<{ accrued: boolean; amountMinor: number; ruleVersion: number | null }> {
  const rules = await tx.select().from(commissionRules).where(eq(commissionRules.organizationId, payment.organizationId));
  const rule = selectApplicableRule(rules, eligibleAt);
  if (!rule) {
    await writeAudit(tx, {
      organizationId: payment.organizationId,
      actorType: "system",
      action: "commission.no_applicable_rule",
      entityType: "payment_intent",
      entityId: payment.id,
    });
    return { accrued: false, amountMinor: 0, ruleVersion: null };
  }
  const calc = computeAccrual(payment.amountMinor, rule);
  const inserted = await tx
    .insert(commissionEntries)
    .values({
      organizationId: payment.organizationId,
      paymentIntentId: payment.id,
      entryType: "accrual",
      ruleId: calc.ruleId,
      ruleVersion: calc.ruleVersion,
      ratePpm: calc.ratePpm,
      baseAmountMinor: calc.baseAmountMinor,
      amountMinor: calc.amountMinor,
      reason: `Comissão contratual v${calc.ruleVersion} sobre pagamento elegível`,
    })
    .onConflictDoNothing()
    .returning({ id: commissionEntries.id });
  if (inserted[0]) {
    await recordEvents(tx, [
      {
        organizationId: payment.organizationId,
        paymentIntentId: payment.id,
        stage: "commission_accrual",
        eventType: "commission.accrual",
        actorType: "system",
        summary: `Comissão apurada: ${formatMzn(calc.amountMinor)} (${ppmToPercentString(calc.ratePpm)}% · regra v${calc.ruleVersion})`,
        metadata: { amountMinor: calc.amountMinor, ratePpm: calc.ratePpm, ruleVersion: calc.ruleVersion },
        isSimulated: payment.isSimulated ?? true,
        dedupeKey: `commission:${inserted[0].id}`,
        occurredAt: eligibleAt,
      },
    ]);
  }
  return { accrued: inserted.length > 0, amountMinor: calc.amountMinor, ruleVersion: calc.ruleVersion };
}

/** Compensating reversal for a reversed payment (never edits the original accrual). */
export async function reverseCommission(
  tx: Tx,
  payment: { id: string; organizationId: string; isSimulated?: boolean },
  reason: string,
  at: Date = new Date(),
): Promise<{ reversedMinor: number }> {
  const entries = await tx
    .select()
    .from(commissionEntries)
    .where(eq(commissionEntries.paymentIntentId, payment.id))
    .orderBy(asc(commissionEntries.createdAt));
  if (entries.length === 0 || entries.some((e) => e.entryType === "reversal")) return { reversedMinor: 0 };
  const amount = computeReversalAmount(entries);
  if (amount === 0) return { reversedMinor: 0 };
  const accrual = entries.find((e) => e.entryType === "accrual");
  const reversal = await tx
    .insert(commissionEntries)
    .values({
      organizationId: payment.organizationId,
      paymentIntentId: payment.id,
      entryType: "reversal",
      ruleId: accrual?.ruleId ?? null,
      ruleVersion: accrual?.ruleVersion ?? null,
      ratePpm: accrual?.ratePpm ?? null,
      baseAmountMinor: accrual?.baseAmountMinor ?? null,
      amountMinor: amount,
      compensatesEntryId: accrual?.id ?? null,
      reason: reason.slice(0, 500),
      createdAt: at,
    })
    .onConflictDoNothing()
    .returning({ id: commissionEntries.id });
  if (reversal[0]) {
    await recordEvents(tx, [
      {
        organizationId: payment.organizationId,
        paymentIntentId: payment.id,
        stage: "commission_accrual",
        eventType: "commission.reversal",
        actorType: "system",
        summary: `Comissão revertida: ${formatMzn(amount)} (entrada compensatória)`,
        metadata: { amountMinor: amount },
        isSimulated: payment.isSimulated ?? true,
        dedupeKey: `commission:${reversal[0].id}`,
        occurredAt: at,
      },
    ]);
  }
  return { reversedMinor: amount };
}

/** Manual adjustment: always a NEW signed entry with a mandatory reason. */
export async function createAdjustment(
  db: Database,
  input: { organizationId: string; paymentIntentId: string | null; amountMinor: number; reason: string },
  actor: Actor,
) {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor === 0) {
    throw new HttpError(422, "invalid_amount", "O ajuste deve ser um valor diferente de zero.");
  }
  if (input.reason.trim().length < 10) throw new HttpError(422, "reason_required", "Indique um motivo (mín. 10 caracteres).");
  return db.transaction(async (tx) => {
    const [entry] = await tx
      .insert(commissionEntries)
      .values({
        organizationId: input.organizationId,
        paymentIntentId: input.paymentIntentId,
        entryType: "adjustment",
        amountMinor: input.amountMinor,
        reason: input.reason.trim(),
        createdBy: actor.userId,
      })
      .returning();
    await writeAudit(tx, {
      organizationId: input.organizationId,
      actorType: "user",
      actorUserId: actor.userId,
      action: "commission.adjustment_created",
      entityType: "commission_entry",
      entityId: entry!.id,
      metadata: { amountMinor: input.amountMinor, reason: input.reason.trim() },
    });
    if (input.paymentIntentId) {
      await recordEvents(tx, [
        {
          organizationId: input.organizationId,
          paymentIntentId: input.paymentIntentId,
          stage: "commission_accrual",
          eventType: "commission.adjustment",
          actorType: "user",
          actorUserId: actor.userId,
          summary: `Ajuste de comissão ${formatMzn(input.amountMinor)} — ${input.reason.trim()}`,
          dedupeKey: `commission:${entry!.id}`,
        },
      ]);
    }
    return entry!;
  });
}

/**
 * Publishes a new rule version. The previous open-ended rule is closed at the new
 * rule's start (kept for history). Existing ledger entries are never touched.
 */
export async function createRuleVersion(
  db: Database,
  input: { organizationId: string; ratePpm: number; effectiveFrom: Date; effectiveTo: Date | null; contractReference: string; notes?: string },
  actor: Actor,
  now: Date = new Date(),
) {
  return db.transaction(async (tx) => {
    // Serialise rule changes per organisation.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"commission_rules:" + input.organizationId}))`);
    const existing = await tx.select().from(commissionRules).where(eq(commissionRules.organizationId, input.organizationId));
    const err = validateNewRule(existing, input, now);
    if (err) {
      const messages = {
        rate_out_of_range: "Taxa fora do intervalo permitido (0% – 10%).",
        starts_in_past: "A nova regra não pode começar no passado (sem efeitos retroactivos).",
        invalid_window: "A data de expiração deve ser posterior à data de início.",
        before_current_rule: "A nova versão tem de começar depois da versão actual.",
      } as const;
      throw new HttpError(422, err, messages[err]);
    }
    const nextVersion = existing.reduce((m, r) => Math.max(m, r.version), 0) + 1;
    // Close every rule still open at the new start date.
    for (const r of existing) {
      if (r.status === "draft") continue;
      if (!r.effectiveTo || r.effectiveTo.getTime() > input.effectiveFrom.getTime()) {
        await tx
          .update(commissionRules)
          .set({ effectiveTo: input.effectiveFrom, status: "superseded" })
          .where(eq(commissionRules.id, r.id));
      }
    }
    const [rule] = await tx
      .insert(commissionRules)
      .values({
        organizationId: input.organizationId,
        version: nextVersion,
        ratePpm: input.ratePpm,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo,
        status: "active",
        contractReference: input.contractReference,
        notes: input.notes ?? null,
        createdBy: actor.userId,
      })
      .returning();
    await writeAudit(tx, {
      organizationId: input.organizationId,
      actorType: "user",
      actorUserId: actor.userId,
      action: "commission.rule_version_created",
      entityType: "commission_rule",
      entityId: rule!.id,
      metadata: { version: nextVersion, ratePpm: input.ratePpm, effectiveFrom: input.effectiveFrom.toISOString(), contractReference: input.contractReference },
    });
    return rule!;
  });
}

/** Issues a (simulated) commission invoice for every not-yet-invoiced ledger entry in the period. */
export async function issueInvoice(
  db: Database,
  input: { organizationId: string; periodStart: string; periodEnd: string },
  actor: Actor,
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"commission_invoice:" + input.organizationId}))`);
    const start = new Date(`${input.periodStart}T00:00:00+02:00`);
    const endExclusive = new Date(new Date(`${input.periodEnd}T00:00:00+02:00`).getTime() + 86_400_000);
    if (!(endExclusive > start)) throw new HttpError(422, "invalid_period", "Período inválido.");

    const pending = await tx
      .select({ id: commissionEntries.id, amountMinor: commissionEntries.amountMinor })
      .from(commissionEntries)
      .leftJoin(commissionInvoiceLines, eq(commissionInvoiceLines.commissionEntryId, commissionEntries.id))
      .where(
        and(
          eq(commissionEntries.organizationId, input.organizationId),
          isNull(commissionInvoiceLines.id),
          gte(commissionEntries.createdAt, start),
          lt(commissionEntries.createdAt, endExclusive),
        ),
      );
    if (pending.length === 0 || pending.reduce((a, e) => a + e.amountMinor, 0) <= 0) {
      throw new HttpError(422, "nothing_to_invoice", "Não há comissões por facturar neste período.");
    }
    return createInvoice(tx, { organizationId: input.organizationId, periodStart: input.periodStart, periodEnd: input.periodEnd, entries: pending }, actor);
  });
}

/** Demo Control Center: invoice the not-yet-invoiced ledger entries of ONE payment. */
export async function issueInvoiceForPayment(db: Database, input: { paymentIntentId: string }, actor: Actor) {
  return db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ organizationId: commissionEntries.organizationId })
      .from(commissionEntries)
      .where(eq(commissionEntries.paymentIntentId, input.paymentIntentId))
      .limit(1);
    if (!owner) throw new HttpError(422, "nothing_to_invoice", "Este pagamento não tem comissão registada.");
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"commission_invoice:" + owner.organizationId}))`);
    const pending = await tx
      .select({ id: commissionEntries.id, amountMinor: commissionEntries.amountMinor, paymentIntentId: commissionEntries.paymentIntentId })
      .from(commissionEntries)
      .leftJoin(commissionInvoiceLines, eq(commissionInvoiceLines.commissionEntryId, commissionEntries.id))
      .where(and(eq(commissionEntries.paymentIntentId, input.paymentIntentId), isNull(commissionInvoiceLines.id)));
    const total = pending.reduce((a, e) => a + e.amountMinor, 0);
    if (pending.length === 0) throw new HttpError(422, "nothing_to_invoice", "A comissão deste pagamento já está facturada.");
    if (total <= 0) throw new HttpError(422, "nothing_to_invoice", "O saldo da comissão por facturar é nulo ou negativo (será compensado na próxima factura do período).");
    const today = new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);
    return createInvoice(tx, { organizationId: owner.organizationId, periodStart: today, periodEnd: today, entries: pending }, actor);
  });
}

async function createInvoice(
  tx: Executor,
  input: { organizationId: string; periodStart: string; periodEnd: string; entries: { id: string; amountMinor: number; paymentIntentId?: string | null }[] },
  actor: Actor,
) {
  const total = input.entries.reduce((a, e) => a + e.amountMinor, 0);
  const [{ count }] = (await tx.select({ count: sql<number>`count(*)::int` }).from(commissionInvoices)) as [{ count: number }];
  const invoiceNumber = `SPC-INV-${input.periodEnd.slice(0, 7).replace("-", "")}-${String(count + 1).padStart(4, "0")}`;
  const [invoice] = await tx
    .insert(commissionInvoices)
    .values({
      organizationId: input.organizationId,
      invoiceNumber,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      amountMinor: total,
      createdBy: actor.userId,
    })
    .returning();
  await tx.insert(commissionInvoiceLines).values(input.entries.map((e) => ({ invoiceId: invoice!.id, commissionEntryId: e.id, amountMinor: e.amountMinor })));
  await writeAudit(tx, {
    organizationId: input.organizationId,
    actorType: "user",
    actorUserId: actor.userId,
    action: "commission.invoice_issued",
    entityType: "commission_invoice",
    entityId: invoice!.id,
    metadata: { invoiceNumber, amountMinor: total, lines: input.entries.length, simulated: true },
  });
  const paymentIds = await paymentsOfInvoice(tx, invoice!.id);
  await recordEvents(
    tx,
    paymentIds.map<LifecycleEventInput>((pid) => ({
      organizationId: input.organizationId,
      paymentIntentId: pid,
      stage: "commission_invoicing",
      eventType: "commission.invoiced",
      actorType: "user",
      actorUserId: actor.userId,
      summary: `Comissão incluída na factura ${invoiceNumber} (simulada)`,
      metadata: { invoiceNumber, invoiceAmountMinor: total },
      dedupeKey: `invoice:${invoice!.id}:${pid}`,
    })),
  );
  return invoice!;
}

async function paymentsOfInvoice(tx: Executor, invoiceId: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ id: commissionEntries.paymentIntentId })
    .from(commissionInvoiceLines)
    .innerJoin(commissionEntries, eq(commissionEntries.id, commissionInvoiceLines.commissionEntryId))
    .where(eq(commissionInvoiceLines.invoiceId, invoiceId));
  return rows.map((r) => r.id).filter((x): x is string => !!x);
}

/**
 * Records a (simulated / manually entered) collection against an invoice.
 * Accrued commission becomes "collected" ONLY through this explicit event.
 */
export async function recordCollection(
  db: Database,
  input: { invoiceId: string; amountMinor: number; receivedAt: Date; collectionReference: string; method: string; notes?: string },
  actor: Actor,
) {
  return db.transaction(async (tx) => {
    const lockedRows = await tx.execute<{ id: string }>(sql`SELECT id FROM commission_invoices WHERE id = ${input.invoiceId} FOR UPDATE`);
    if (lockedRows.rows.length === 0) throw new HttpError(404, "not_found", "Factura não encontrada.");
    const [invoice] = await tx.select().from(commissionInvoices).where(eq(commissionInvoices.id, input.invoiceId));
    if (!invoice || invoice.status === "void") throw new HttpError(422, "invoice_void", "Factura anulada.");
    const collected = await collectedFor(tx, invoice.id);
    const outstanding = invoice.amountMinor - collected;
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw new HttpError(422, "invalid_amount", "Valor de cobrança inválido.");
    }
    if (input.amountMinor > outstanding) {
      throw new HttpError(422, "overpayment", "O valor excede o montante em dívida da factura.");
    }
    const [payout] = await tx
      .insert(commissionPayouts)
      .values({
        organizationId: invoice.organizationId,
        invoiceId: invoice.id,
        amountMinor: input.amountMinor,
        receivedAt: input.receivedAt,
        collectionReference: input.collectionReference,
        method: input.method,
        notes: input.notes ?? null,
        recordedBy: actor.userId,
      })
      .returning();
    const status = invoiceStatusFor(invoice.amountMinor, collected + input.amountMinor);
    await tx.update(commissionInvoices).set({ status }).where(eq(commissionInvoices.id, invoice.id));
    await writeAudit(tx, {
      organizationId: invoice.organizationId,
      actorType: "user",
      actorUserId: actor.userId,
      action: "commission.collection_recorded",
      entityType: "commission_invoice",
      entityId: invoice.id,
      metadata: { amountMinor: input.amountMinor, collectionReference: input.collectionReference, newStatus: status, simulated: true },
    });
    const paymentIds = await paymentsOfInvoice(tx, invoice.id);
    await recordEvents(
      tx,
      paymentIds.map<LifecycleEventInput>((pid) => ({
        organizationId: invoice.organizationId,
        paymentIntentId: pid,
        stage: "commission_collection",
        eventType: status === "paid" ? "commission.collected" : "commission.partially_collected",
        actorType: "user",
        actorUserId: actor.userId,
        summary: `Cobrança ${input.collectionReference} de ${formatMzn(input.amountMinor)} na factura ${invoice.invoiceNumber} — ${status === "paid" ? "factura paga" : "pagamento parcial"} (simulada)`,
        metadata: { invoiceNumber: invoice.invoiceNumber, collectionReference: input.collectionReference, amountMinor: input.amountMinor, invoiceStatus: status },
        dedupeKey: `payout:${payout!.id}:${pid}`,
        occurredAt: input.receivedAt,
      })),
    );
    return { payout: payout!, status };
  });
}

async function collectedFor(db: Executor, invoiceId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${commissionPayouts.amountMinor}), 0)` })
    .from(commissionPayouts)
    .where(eq(commissionPayouts.invoiceId, invoiceId));
  return Number(row?.total ?? 0);
}
