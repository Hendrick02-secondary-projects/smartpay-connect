import "server-only";
import { and, asc, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@/lib/db";
import {
  bankAccounts,
  bankSettlements,
  kitAllocations,
  paymentClosures,
  paymentDebitNotes,
  paymentEvents,
  paymentIntents,
  paymentTransactions,
  reconciliationRecords,
  settlementBatches,
  users,
} from "@/lib/db/schema";
import { listPaymentAllocations } from "@/lib/kit/service";
import { getLifecycle, listTimeline } from "@/lib/lifecycle/service";

/**
 * Every function here takes `organizationId` from the authenticated session (never
 * from the request) and applies it to EVERY query: tenant isolation by construction.
 */

export const transactionFiltersSchema = z.object({
  q: z.string().trim().max(80).optional().catch(undefined),
  status: z.enum(["created", "pending", "successful", "failed", "cancelled", "reversed"]).optional().catch(undefined),
  method: z.enum(["card", "mpesa", "emola"]).optional().catch(undefined),
  account: z.string().max(32).optional().catch(undefined),
  recon: z.enum(["unreconciled", "reconciled", "exception", "manually_reconciled"]).optional().catch(undefined),
  kit: z.enum(["pending", "partial", "complete", "attention"]).optional().catch(undefined),
  closure: z.enum(["open", "closed"]).optional().catch(undefined),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(10_000).catch(1).default(1),
});
export type TransactionFilters = z.infer<typeof transactionFiltersSchema>;
export const PAGE_SIZE = 20;

const maputoDayStart = (d: string) => new Date(`${d}T00:00:00+02:00`);

function filterWhere(organizationId: string, f: TransactionFilters): SQL {
  const parts: SQL[] = [eq(paymentIntents.organizationId, organizationId)];
  if (f.status) parts.push(eq(paymentIntents.status, f.status));
  if (f.method) parts.push(eq(paymentIntents.paymentMethod, f.method));
  if (f.recon) parts.push(eq(paymentIntents.reconciliationStatus, f.recon));
  if (f.account) parts.push(eq(bankAccounts.code, f.account));
  if (f.kit) {
    const counts = sql`(select count(*) filter (where a.status = 'allocated') as al, count(*) filter (where a.status = 'issue') as iss, count(*) as tot from ${kitAllocations} a where a.payment_intent_id = ${paymentIntents.id})`;
    if (f.kit === "complete") parts.push(sql`exists (select 1 from ${counts} c where c.tot > 0 and c.al = c.tot)`);
    if (f.kit === "attention") parts.push(sql`exists (select 1 from ${counts} c where c.iss > 0)`);
    if (f.kit === "partial") parts.push(sql`exists (select 1 from ${counts} c where c.al > 0 and c.al < c.tot)`);
    if (f.kit === "pending")
      parts.push(sql`${paymentIntents.status} = 'successful' and exists (select 1 from ${counts} c where c.tot > 0 and c.al < c.tot)`);
  }
  if (f.closure) {
    const open = sql`exists (select 1 from ${paymentClosures} pc where pc.payment_intent_id = ${paymentIntents.id} and pc.kind = 'operational' and pc.reopened_at is null)`;
    parts.push(f.closure === "closed" ? open : sql`${paymentIntents.status} in ('successful','reversed') and not ${open}`);
  }
  if (f.from) parts.push(gte(paymentIntents.createdAt, maputoDayStart(f.from)));
  if (f.to) parts.push(lt(paymentIntents.createdAt, new Date(maputoDayStart(f.to).getTime() + 86_400_000)));
  if (f.q) {
    const like = `%${f.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    parts.push(
      or(
        ilike(paymentIntents.reference, like),
        ilike(paymentIntents.customerName, like),
        ilike(paymentIntents.customerPhone, like),
        sql`exists (select 1 from ${paymentDebitNotes} dn where dn.payment_intent_id = ${paymentIntents.id} and dn.debit_note_number ilike ${like})`,
      )!,
    );
  }
  return and(...parts)!;
}

export async function listTransactions(db: Database, organizationId: string, f: TransactionFilters, pageSize = PAGE_SIZE) {
  const where = filterWhere(organizationId, f);
  const [countRow] = await db
    .select({ total: sql<number>`count(*)::int`, amount: sql<string>`coalesce(sum(${paymentIntents.amountMinor}), 0)` })
    .from(paymentIntents)
    .innerJoin(bankAccounts, eq(bankAccounts.id, paymentIntents.bankAccountId))
    .where(where);
  const rows = await db
    .select({
      id: paymentIntents.id,
      reference: paymentIntents.reference,
      customerName: paymentIntents.customerName,
      customerPhone: paymentIntents.customerPhone,
      amountMinor: paymentIntents.amountMinor,
      method: paymentIntents.paymentMethod,
      status: paymentIntents.status,
      reconciliationStatus: paymentIntents.reconciliationStatus,
      createdAt: paymentIntents.createdAt,
      accountCode: bankAccounts.code,
      bankName: bankAccounts.bankName,
      accountNumberMasked: bankAccounts.accountNumberMasked,
      debitNotes: sql<string>`(select string_agg(dn.debit_note_number, ', ' order by dn.position) from ${paymentDebitNotes} dn where dn.payment_intent_id = ${paymentIntents.id})`,
      kitAllocated: sql<number>`(select count(*)::int from ${kitAllocations} a where a.payment_intent_id = ${paymentIntents.id} and a.status = 'allocated')`,
      kitTotal: sql<number>`(select count(*)::int from ${kitAllocations} a where a.payment_intent_id = ${paymentIntents.id})`,
      kitIssues: sql<number>`(select count(*)::int from ${kitAllocations} a where a.payment_intent_id = ${paymentIntents.id} and a.status = 'issue')`,
      operationallyClosed: sql<boolean>`exists (select 1 from ${paymentClosures} pc where pc.payment_intent_id = ${paymentIntents.id} and pc.kind = 'operational' and pc.reopened_at is null)`,
    })
    .from(paymentIntents)
    .innerJoin(bankAccounts, eq(bankAccounts.id, paymentIntents.bankAccountId))
    .where(where)
    .orderBy(desc(paymentIntents.createdAt), desc(paymentIntents.id))
    .limit(pageSize)
    .offset((f.page - 1) * pageSize);
  return { rows, total: countRow?.total ?? 0, totalAmountMinor: Number(countRow?.amount ?? 0), page: f.page, pageSize };
}

export async function getTransactionDetail(db: Database, organizationId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await db
    .select({ intent: paymentIntents, account: bankAccounts })
    .from(paymentIntents)
    .innerJoin(bankAccounts, eq(bankAccounts.id, paymentIntents.bankAccountId))
    .where(and(eq(paymentIntents.id, id), eq(paymentIntents.organizationId, organizationId)))
    .limit(1);
  if (!row) return null;
  const [notes, events, transactions, recon, allocations, lifecycle, timeline] = await Promise.all([
    db.select().from(paymentDebitNotes).where(eq(paymentDebitNotes.paymentIntentId, id)).orderBy(asc(paymentDebitNotes.position)),
    db
      .select({
        eventType: paymentEvents.eventType,
        fromStatus: paymentEvents.fromStatus,
        toStatus: paymentEvents.toStatus,
        processingStatus: paymentEvents.processingStatus,
        processingNote: paymentEvents.processingNote,
        signatureValid: paymentEvents.signatureValid,
        receivedAt: paymentEvents.receivedAt,
      })
      .from(paymentEvents)
      .where(and(eq(paymentEvents.paymentIntentId, id), eq(paymentEvents.organizationId, organizationId)))
      .orderBy(asc(paymentEvents.receivedAt)),
    db.select().from(paymentTransactions).where(and(eq(paymentTransactions.paymentIntentId, id), eq(paymentTransactions.organizationId, organizationId))),
    db
      .select({ record: reconciliationRecords, settlement: bankSettlements, batchRef: settlementBatches.batchReference })
      .from(reconciliationRecords)
      .innerJoin(bankSettlements, eq(bankSettlements.id, reconciliationRecords.bankSettlementId))
      .innerJoin(settlementBatches, eq(settlementBatches.id, reconciliationRecords.batchId))
      .where(and(eq(reconciliationRecords.paymentIntentId, id), eq(reconciliationRecords.organizationId, organizationId)))
      .orderBy(asc(reconciliationRecords.createdAt)),
    listPaymentAllocations(db, id),
    getLifecycle(db, id),
    listTimeline(db, id, "tenant"),
  ]);
  return { ...row, notes, events, transactions, recon, allocations, lifecycle: lifecycle!, timeline };
}

export async function getDashboardData(db: Database, organizationId: string, days = 90) {
  const since = new Date(Date.now() - days * 86_400_000);
  const scope = and(eq(paymentIntents.organizationId, organizationId), gte(paymentIntents.createdAt, since));

  const [kpi] = await db
    .select({
      total: sql<number>`count(*)::int`,
      successful: sql<number>`count(*) filter (where ${paymentIntents.status} = 'successful')::int`,
      pending: sql<number>`count(*) filter (where ${paymentIntents.status} in ('pending','created'))::int`,
      failed: sql<number>`count(*) filter (where ${paymentIntents.status} in ('failed','cancelled'))::int`,
      reversed: sql<number>`count(*) filter (where ${paymentIntents.status} = 'reversed')::int`,
      paidMinor: sql<string>`coalesce(sum(${paymentIntents.amountMinor}) filter (where ${paymentIntents.status} = 'successful'), 0)`,
      awaitingReconMinor: sql<string>`coalesce(sum(${paymentIntents.amountMinor}) filter (where ${paymentIntents.status} = 'successful' and ${paymentIntents.reconciliationStatus} in ('unreconciled','exception')), 0)`,
      reconciledMinor: sql<string>`coalesce(sum(${paymentIntents.amountMinor}) filter (where ${paymentIntents.reconciliationStatus} in ('reconciled','manually_reconciled')), 0)`,
      completed: sql<number>`count(*) filter (where ${paymentIntents.status} in ('successful','failed','cancelled','reversed'))::int`,
    })
    .from(paymentIntents)
    .where(scope);

  const daily = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${paymentIntents.createdAt} at time zone 'Africa/Maputo'), 'YYYY-MM-DD')`,
      count: sql<number>`count(*)::int`,
      successful: sql<number>`count(*) filter (where ${paymentIntents.status} = 'successful')::int`,
      failed: sql<number>`count(*) filter (where ${paymentIntents.status} in ('failed','cancelled'))::int`,
      amountMinor: sql<string>`coalesce(sum(${paymentIntents.amountMinor}) filter (where ${paymentIntents.status} = 'successful'), 0)`,
    })
    .from(paymentIntents)
    .where(scope)
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  const byMethod = await db
    .select({
      method: paymentIntents.paymentMethod,
      count: sql<number>`count(*)::int`,
      amountMinor: sql<string>`coalesce(sum(${paymentIntents.amountMinor}) filter (where ${paymentIntents.status} = 'successful'), 0)`,
    })
    .from(paymentIntents)
    .where(scope)
    .groupBy(paymentIntents.paymentMethod);

  const byAccount = await db
    .select({
      code: bankAccounts.code,
      bankName: bankAccounts.bankName,
      purpose: bankAccounts.purpose,
      count: sql<number>`count(*)::int`,
      amountMinor: sql<string>`coalesce(sum(${paymentIntents.amountMinor}) filter (where ${paymentIntents.status} = 'successful'), 0)`,
    })
    .from(paymentIntents)
    .innerJoin(bankAccounts, eq(bankAccounts.id, paymentIntents.bankAccountId))
    .where(scope)
    .groupBy(bankAccounts.code, bankAccounts.bankName, bankAccounts.purpose)
    .orderBy(bankAccounts.code);

  const byRecon = await db
    .select({ state: paymentIntents.reconciliationStatus, count: sql<number>`count(*)::int`, amountMinor: sql<string>`coalesce(sum(${paymentIntents.amountMinor}),0)` })
    .from(paymentIntents)
    .where(and(scope, inArray(paymentIntents.status, ["successful", "reversed"])))
    .groupBy(paymentIntents.reconciliationStatus);

  const recent = await listTransactions(db, organizationId, { page: 1 }, 6);

  // Operational funnel (confirmed payments in the period)
  const [funnel] = await db
    .select({
      confirmed: sql<number>`count(*) filter (where ${paymentIntents.status} = 'successful')::int`,
      settled: sql<number>`count(*) filter (where ${paymentIntents.status} = 'successful' and exists (select 1 from ${bankSettlements} bs where bs.organization_id = ${paymentIntents.organizationId} and bs.payment_reference = ${paymentIntents.reference} and bs.movement_type = 'credit' and not bs.is_duplicate_row))::int`,
      reconciled: sql<number>`count(*) filter (where ${paymentIntents.status} = 'successful' and ${paymentIntents.reconciliationStatus} in ('reconciled','manually_reconciled'))::int`,
      allocated: sql<number>`count(*) filter (where ${paymentIntents.status} = 'successful' and not exists (select 1 from ${kitAllocations} a where a.payment_intent_id = ${paymentIntents.id} and a.status <> 'allocated') and exists (select 1 from ${kitAllocations} a where a.payment_intent_id = ${paymentIntents.id}))::int`,
      closed: sql<number>`count(*) filter (where ${paymentIntents.status} = 'successful' and exists (select 1 from ${paymentClosures} pc where pc.payment_intent_id = ${paymentIntents.id} and pc.kind = 'operational' and pc.reopened_at is null))::int`,
    })
    .from(paymentIntents)
    .where(scope);
  const [kit] = await db
    .select({
      pendingNotes: sql<number>`count(*) filter (where ${kitAllocations.status} = 'pending' and ${paymentIntents.reconciliationStatus} in ('reconciled','manually_reconciled'))::int`,
      issues: sql<number>`count(*) filter (where ${kitAllocations.status} = 'issue')::int`,
      toVoid: sql<number>`count(*) filter (where ${kitAllocations.status} = 'allocated' and ${paymentIntents.status} = 'reversed')::int`,
    })
    .from(kitAllocations)
    .innerJoin(paymentIntents, eq(paymentIntents.id, kitAllocations.paymentIntentId))
    .where(eq(kitAllocations.organizationId, organizationId));
  const [pendingBatches] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(settlementBatches)
    .where(and(eq(settlementBatches.organizationId, organizationId), eq(settlementBatches.reconciliationState, "pending")));

  const k = kpi!;
  return {
    days,
    kpis: {
      total: k.total,
      successful: k.successful,
      pending: k.pending,
      failed: k.failed,
      reversed: k.reversed,
      paidMinor: Number(k.paidMinor),
      awaitingReconMinor: Number(k.awaitingReconMinor),
      reconciledMinor: Number(k.reconciledMinor),
      successRate: k.completed ? k.successful / k.completed : 0,
    },
    daily: daily.map((d) => ({ ...d, amountMinor: Number(d.amountMinor) })),
    byMethod: byMethod.map((m) => ({ ...m, amountMinor: Number(m.amountMinor) })),
    byAccount: byAccount.map((a) => ({ ...a, amountMinor: Number(a.amountMinor) })),
    byRecon: byRecon.map((r) => ({ ...r, amountMinor: Number(r.amountMinor) })),
    recent: recent.rows,
    funnel: funnel!,
    kit: kit!,
    pendingBatches: pendingBatches?.n ?? 0,
  };
}

export const allocationQueueSchema = z.object({
  view: z.enum(["to_allocate", "issues", "to_void", "ready_to_close", "allocated"]).catch("to_allocate").default("to_allocate"),
  page: z.coerce.number().int().min(1).max(10_000).catch(1).default(1),
});

/** Work queue for the KIT allocation page (tenant-scoped). */
export async function listAllocationQueue(db: Database, organizationId: string, f: z.infer<typeof allocationQueueSchema>) {
  const reconciled = sql`${paymentIntents.reconciliationStatus} in ('reconciled','manually_reconciled')`;
  const openClosure = sql`exists (select 1 from ${paymentClosures} pc where pc.payment_intent_id = ${paymentIntents.id} and pc.kind = 'operational' and pc.reopened_at is null)`;
  const views = {
    to_allocate: and(eq(kitAllocations.status, "pending"), eq(paymentIntents.status, "successful"), reconciled),
    issues: eq(kitAllocations.status, "issue"),
    to_void: and(eq(kitAllocations.status, "allocated"), eq(paymentIntents.status, "reversed")),
    allocated: and(eq(kitAllocations.status, "allocated"), eq(paymentIntents.status, "successful")),
    ready_to_close: sql`${paymentIntents.status} = 'successful' and ${reconciled} and not ${openClosure} and not exists (select 1 from ${kitAllocations} k where k.payment_intent_id = ${paymentIntents.id} and k.status <> 'allocated')`,
  } as const;
  const where = and(eq(kitAllocations.organizationId, organizationId), views[f.view]);
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(kitAllocations)
    .innerJoin(paymentIntents, eq(paymentIntents.id, kitAllocations.paymentIntentId))
    .where(where);
  const rows = await db
    .select({
      id: kitAllocations.id,
      status: kitAllocations.status,
      receiptReference: kitAllocations.receiptReference,
      allocatedOn: kitAllocations.allocatedOn,
      notes: kitAllocations.notes,
      version: kitAllocations.version,
      updatedAt: kitAllocations.updatedAt,
      debitNoteNumber: paymentDebitNotes.debitNoteNumber,
      amountMinor: paymentDebitNotes.amountMinor,
      paymentId: paymentIntents.id,
      reference: paymentIntents.reference,
      customerName: paymentIntents.customerName,
      paymentStatus: paymentIntents.status,
      reconciliationStatus: paymentIntents.reconciliationStatus,
      paymentCreatedAt: paymentIntents.createdAt,
      operationallyClosed: sql<boolean>`${openClosure}`,
    })
    .from(kitAllocations)
    .innerJoin(paymentIntents, eq(paymentIntents.id, kitAllocations.paymentIntentId))
    .innerJoin(paymentDebitNotes, eq(paymentDebitNotes.id, kitAllocations.debitNoteId))
    .where(where)
    .orderBy(asc(paymentIntents.createdAt), asc(paymentDebitNotes.position))
    .limit(PAGE_SIZE)
    .offset((f.page - 1) * PAGE_SIZE);
  const counts = await db
    .select({
      to_allocate: sql<number>`count(*) filter (where ${views.to_allocate})::int`,
      issues: sql<number>`count(*) filter (where ${views.issues})::int`,
      to_void: sql<number>`count(*) filter (where ${views.to_void})::int`,
      allocated: sql<number>`count(*) filter (where ${views.allocated})::int`,
      ready_to_close: sql<number>`count(distinct ${paymentIntents.id}) filter (where ${views.ready_to_close})::int`,
    })
    .from(kitAllocations)
    .innerJoin(paymentIntents, eq(paymentIntents.id, kitAllocations.paymentIntentId))
    .where(eq(kitAllocations.organizationId, organizationId));
  return { rows, total: count?.n ?? 0, page: f.page, counts: counts[0]! };
}

export async function listAccounts(db: Database, organizationId: string) {
  return db
    .select({ code: bankAccounts.code, bankName: bankAccounts.bankName, purpose: bankAccounts.purpose, accountNumberMasked: bankAccounts.accountNumberMasked })
    .from(bankAccounts)
    .where(eq(bankAccounts.organizationId, organizationId))
    .orderBy(asc(bankAccounts.displayOrder));
}

export const reconFiltersSchema = z.object({
  status: z.enum(["matched", "unmatched", "amount_mismatch", "duplicate_settlement", "under_review", "manually_reconciled", "rejected", "exceptions"]).catch("exceptions").default("exceptions"),
  batch: z.string().uuid().optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(10_000).catch(1).default(1),
});

export async function getReconciliationData(db: Database, organizationId: string, f: z.infer<typeof reconFiltersSchema>) {
  const batches = await db
    .select({ batch: settlementBatches, by: users.name })
    .from(settlementBatches)
    .leftJoin(users, eq(users.id, settlementBatches.createdBy))
    .where(eq(settlementBatches.organizationId, organizationId))
    .orderBy(desc(settlementBatches.createdAt))
    .limit(12);

  const statusCond =
    f.status === "exceptions"
      ? inArray(reconciliationRecords.status, ["unmatched", "amount_mismatch", "duplicate_settlement", "under_review"])
      : eq(reconciliationRecords.status, f.status);
  const where = and(eq(reconciliationRecords.organizationId, organizationId), statusCond, f.batch ? eq(reconciliationRecords.batchId, f.batch) : undefined);

  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(reconciliationRecords).where(where);
  const records = await db
    .select({
      id: reconciliationRecords.id,
      status: reconciliationRecords.status,
      reasonCode: reconciliationRecords.reasonCode,
      expectedAmountMinor: reconciliationRecords.expectedAmountMinor,
      settledAmountMinor: reconciliationRecords.settledAmountMinor,
      differenceMinor: reconciliationRecords.differenceMinor,
      reviewReason: reconciliationRecords.reviewReason,
      reviewedAt: reconciliationRecords.reviewedAt,
      reviewer: users.name,
      settlementReference: bankSettlements.settlementReference,
      paymentReference: bankSettlements.paymentReference,
      movementType: bankSettlements.movementType,
      bankAccountCode: bankSettlements.bankAccountCode,
      valueDate: bankSettlements.valueDate,
      batchReference: settlementBatches.batchReference,
      paymentId: reconciliationRecords.paymentIntentId,
    })
    .from(reconciliationRecords)
    .innerJoin(bankSettlements, eq(bankSettlements.id, reconciliationRecords.bankSettlementId))
    .innerJoin(settlementBatches, eq(settlementBatches.id, reconciliationRecords.batchId))
    .leftJoin(users, eq(users.id, reconciliationRecords.reviewedBy))
    .where(where)
    .orderBy(desc(reconciliationRecords.createdAt), asc(bankSettlements.rowNumber))
    .limit(PAGE_SIZE)
    .offset((f.page - 1) * PAGE_SIZE);

  const statusCounts = await db
    .select({ status: reconciliationRecords.status, n: sql<number>`count(*)::int` })
    .from(reconciliationRecords)
    .where(eq(reconciliationRecords.organizationId, organizationId))
    .groupBy(reconciliationRecords.status);

  // Payment lines (statement credits with a payment ref + aggregate detail lines) carry the gross
  // and the attributable fees; only STATEMENT lines are bank movements (no double counting).
  const paymentLine = sql`${bankSettlements.movementType} = 'credit' and ${bankSettlements.paymentReference} is not null and not ${bankSettlements.isDuplicateRow}`;
  const statementLine = sql`${bankSettlements.lineKind} = 'statement' and not ${bankSettlements.isDuplicateRow}`;
  const [movements] = await db
    .select({
      gross: sql<string>`coalesce(sum(${bankSettlements.grossAmountMinor}) filter (where ${paymentLine}), 0)`,
      gatewayFees: sql<string>`coalesce(sum(${bankSettlements.gatewayFeeMinor}) filter (where ${paymentLine}), 0)`,
      platformFees: sql<string>`coalesce(sum(${bankSettlements.platformFeeMinor}) filter (where ${paymentLine}), 0)`,
      net: sql<string>`coalesce(sum(${bankSettlements.netAmountMinor}) filter (where ${statementLine}), 0)`,
      deducted: sql<string>`coalesce(sum(${bankSettlements.grossAmountMinor} - ${bankSettlements.netAmountMinor}) filter (where ${statementLine} and ${paymentLine}), 0)`,
      debitedGateway: sql<string>`coalesce(sum(${bankSettlements.grossAmountMinor}) filter (where ${statementLine} and ${bankSettlements.movementType} = 'fee_debit' and coalesce(${bankSettlements.feeKind}::text, 'gateway') = 'gateway'), 0)`,
      debitedPlatform: sql<string>`coalesce(sum(${bankSettlements.grossAmountMinor}) filter (where ${statementLine} and ${bankSettlements.movementType} = 'fee_debit' and ${bankSettlements.feeKind} = 'platform'), 0)`,
      bankMovements: sql<number>`count(*) filter (where ${statementLine})::int`,
    })
    .from(bankSettlements)
    .innerJoin(settlementBatches, eq(settlementBatches.id, bankSettlements.batchId))
    .where(and(eq(bankSettlements.organizationId, organizationId), f.batch ? eq(bankSettlements.batchId, f.batch) : undefined));
  const batchLines = f.batch
    ? await db
        .select({
          id: bankSettlements.id,
          settlementReference: bankSettlements.settlementReference,
          paymentReference: bankSettlements.paymentReference,
          movementType: bankSettlements.movementType,
          lineKind: bankSettlements.lineKind,
          feeKind: bankSettlements.feeKind,
          parentSettlementId: bankSettlements.parentSettlementId,
          grossAmountMinor: bankSettlements.grossAmountMinor,
          gatewayFeeMinor: bankSettlements.gatewayFeeMinor,
          platformFeeMinor: bankSettlements.platformFeeMinor,
          netAmountMinor: bankSettlements.netAmountMinor,
          isDuplicateRow: bankSettlements.isDuplicateRow,
          rowNumber: bankSettlements.rowNumber,
        })
        .from(bankSettlements)
        .where(and(eq(bankSettlements.batchId, f.batch), eq(bankSettlements.organizationId, organizationId)))
        .orderBy(asc(bankSettlements.rowNumber))
    : [];

  return {
    batches,
    records,
    total: count?.n ?? 0,
    page: f.page,
    statusCounts: Object.fromEntries(statusCounts.map((s) => [s.status, s.n])) as Record<string, number>,
    movements: {
      gross: Number(movements?.gross ?? 0),
      gatewayFees: Number(movements?.gatewayFees ?? 0),
      platformFees: Number(movements?.platformFees ?? 0),
      net: Number(movements?.net ?? 0),
      deducted: Number(movements?.deducted ?? 0),
      debitedGateway: Number(movements?.debitedGateway ?? 0),
      debitedPlatform: Number(movements?.debitedPlatform ?? 0),
      bankMovements: movements?.bankMovements ?? 0,
    },
    batchLines,
    pendingBatches: batches.filter((b) => b.batch.reconciliationState === "pending"),
  };
}
