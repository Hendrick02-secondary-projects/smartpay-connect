import "server-only";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import {
  commissionEntries,
  commissionInvoiceLines,
  commissionInvoices,
  commissionPayouts,
  commissionRules,
  organizations,
  paymentIntents,
  settlementBatches,
  users,
} from "@/lib/db/schema";
import { deriveLifecycle } from "@/lib/commission/engine";

/** Platform-wide (cross-tenant) read models — callers must be platform owners. */

export async function getOwnerKpis(db: Database) {
  const [vol] = await db
    .select({
      volumeMinor: sql<string>`coalesce(sum(${paymentIntents.amountMinor}) filter (where ${paymentIntents.status} = 'successful'), 0)`,
      successCount: sql<number>`count(*) filter (where ${paymentIntents.status} = 'successful')::int`,
      reversedCount: sql<number>`count(*) filter (where ${paymentIntents.status} = 'reversed')::int`,
    })
    .from(paymentIntents);
  const [ledger] = await db
    .select({
      accrued: sql<string>`coalesce(sum(${commissionEntries.amountMinor}) filter (where ${commissionEntries.entryType} = 'accrual'), 0)`,
      adjustments: sql<string>`coalesce(sum(${commissionEntries.amountMinor}) filter (where ${commissionEntries.entryType} = 'adjustment'), 0)`,
      reversals: sql<string>`coalesce(sum(${commissionEntries.amountMinor}) filter (where ${commissionEntries.entryType} = 'reversal'), 0)`,
      net: sql<string>`coalesce(sum(${commissionEntries.amountMinor}), 0)`,
    })
    .from(commissionEntries);
  const [inv] = await db
    .select({ invoiced: sql<string>`coalesce(sum(${commissionInvoices.amountMinor}) filter (where ${commissionInvoices.status} <> 'void'), 0)` })
    .from(commissionInvoices);
  const [col] = await db.select({ collected: sql<string>`coalesce(sum(${commissionPayouts.amountMinor}), 0)` }).from(commissionPayouts);

  const accrued = Number(ledger?.accrued ?? 0);
  const adjustments = Number(ledger?.adjustments ?? 0) + Number(ledger?.reversals ?? 0);
  const netDue = Number(ledger?.net ?? 0);
  const invoiced = Number(inv?.invoiced ?? 0);
  const collected = Number(col?.collected ?? 0);
  return {
    volumeMinor: Number(vol?.volumeMinor ?? 0),
    successCount: vol?.successCount ?? 0,
    reversedCount: vol?.reversedCount ?? 0,
    accrued,
    adjustments,
    netDue,
    invoiced,
    collected,
    outstanding: netDue - collected,
    notYetInvoiced: netDue - invoiced,
  };
}

export async function getOwnerCharts(db: Database) {
  const monthly = await db
    .select({
      month: sql<string>`to_char(date_trunc('month', ${commissionEntries.createdAt} at time zone 'Africa/Maputo'), 'YYYY-MM')`,
      net: sql<string>`coalesce(sum(${commissionEntries.amountMinor}), 0)`,
      accrued: sql<string>`coalesce(sum(${commissionEntries.amountMinor}) filter (where ${commissionEntries.entryType} = 'accrual'), 0)`,
    })
    .from(commissionEntries)
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  const volume = await db
    .select({
      month: sql<string>`to_char(date_trunc('month', ${paymentIntents.createdAt} at time zone 'Africa/Maputo'), 'YYYY-MM')`,
      volume: sql<string>`coalesce(sum(${paymentIntents.amountMinor}) filter (where ${paymentIntents.status} = 'successful'), 0)`,
      count: sql<number>`count(*) filter (where ${paymentIntents.status} = 'successful')::int`,
    })
    .from(paymentIntents)
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  const byMethod = await db
    .select({ method: paymentIntents.paymentMethod, amount: sql<string>`coalesce(sum(${commissionEntries.amountMinor}), 0)` })
    .from(commissionEntries)
    .innerJoin(paymentIntents, eq(paymentIntents.id, commissionEntries.paymentIntentId))
    .groupBy(paymentIntents.paymentMethod);

  const collectedMonthly = await db
    .select({
      month: sql<string>`to_char(date_trunc('month', ${commissionPayouts.receivedAt} at time zone 'Africa/Maputo'), 'YYYY-MM')`,
      collected: sql<string>`coalesce(sum(${commissionPayouts.amountMinor}), 0)`,
    })
    .from(commissionPayouts)
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  const collectedMap = new Map(collectedMonthly.map((c) => [c.month, Number(c.collected)]));
  let runningNet = 0;
  let runningCollected = 0;
  return {
    monthly: monthly.map((m) => {
      runningNet += Number(m.net);
      runningCollected += collectedMap.get(m.month) ?? 0;
      return {
        label: monthLabel(m.month),
        accrued: Number(m.accrued),
        net: Number(m.net),
        collected: collectedMap.get(m.month) ?? 0,
        outstandingCumulative: runningNet - runningCollected,
        collectedCumulative: runningCollected,
      };
    }),
    volume: volume.map((v) => ({ label: monthLabel(v.month), volume: Number(v.volume), count: v.count })),
    byMethod: byMethod.map((b) => ({ method: b.method, amount: Number(b.amount) })),
  };
}

function monthLabel(ym: string) {
  const [y, m] = ym.split("-");
  const names = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  return `${names[Number(m) - 1]} ${y?.slice(2)}`;
}

export const LEDGER_PAGE_SIZE = 25;

export async function listLedger(db: Database, page: number, pageSize = LEDGER_PAGE_SIZE) {
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(commissionEntries);
  const rows = await db
    .select({
      entry: commissionEntries,
      paymentReference: paymentIntents.reference,
      paymentStatus: paymentIntents.status,
      method: paymentIntents.paymentMethod,
      organization: organizations.name,
      invoiceNumber: commissionInvoices.invoiceNumber,
      invoiceStatus: commissionInvoices.status,
      createdByName: users.name,
    })
    .from(commissionEntries)
    .innerJoin(organizations, eq(organizations.id, commissionEntries.organizationId))
    .leftJoin(paymentIntents, eq(paymentIntents.id, commissionEntries.paymentIntentId))
    .leftJoin(commissionInvoiceLines, eq(commissionInvoiceLines.commissionEntryId, commissionEntries.id))
    .leftJoin(commissionInvoices, eq(commissionInvoices.id, commissionInvoiceLines.invoiceId))
    .leftJoin(users, eq(users.id, commissionEntries.createdBy))
    .orderBy(desc(commissionEntries.createdAt), desc(commissionEntries.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  // Lifecycle per payment is derived from ALL its entries + the accrual's invoice state.
  const paymentIds = [...new Set(rows.map((r) => r.entry.paymentIntentId).filter((x): x is string => !!x))];
  const siblings = paymentIds.length
    ? await db
        .select({ paymentIntentId: commissionEntries.paymentIntentId, entryType: commissionEntries.entryType, amountMinor: commissionEntries.amountMinor, invoiceStatus: commissionInvoices.status })
        .from(commissionEntries)
        .leftJoin(commissionInvoiceLines, eq(commissionInvoiceLines.commissionEntryId, commissionEntries.id))
        .leftJoin(commissionInvoices, eq(commissionInvoices.id, commissionInvoiceLines.invoiceId))
        .where(inArray(commissionEntries.paymentIntentId, paymentIds))
    : [];
  const byPayment = new Map<string, typeof siblings>();
  for (const s of siblings) {
    const list = byPayment.get(s.paymentIntentId!) ?? [];
    list.push(s);
    byPayment.set(s.paymentIntentId!, list);
  }
  return {
    total: count?.n ?? 0,
    rows: rows.map((r) => {
      const sib = r.entry.paymentIntentId ? (byPayment.get(r.entry.paymentIntentId) ?? []) : [];
      const accrualInvoice = sib.find((s) => s.entryType === "accrual")?.invoiceStatus ?? null;
      const lifecycle = r.entry.paymentIntentId
        ? deriveLifecycle({ entries: sib, invoiceStatus: accrualInvoice })
        : r.invoiceStatus === "paid"
          ? "paid"
          : r.invoiceStatus
            ? "invoiced"
            : "adjusted";
      return { ...r, lifecycle };
    }),
  };
}

export async function listRules(db: Database) {
  return db
    .select({ rule: commissionRules, organization: organizations.name, createdByName: users.name })
    .from(commissionRules)
    .innerJoin(organizations, eq(organizations.id, commissionRules.organizationId))
    .leftJoin(users, eq(users.id, commissionRules.createdBy))
    .orderBy(asc(organizations.name), desc(commissionRules.version));
}

export async function listInvoices(db: Database) {
  const invoices = await db
    .select({
      invoice: commissionInvoices,
      organization: organizations.name,
      collected: sql<string>`coalesce((select sum(p.amount_minor) from ${commissionPayouts} p where p.invoice_id = ${commissionInvoices.id}), 0)`,
      lines: sql<number>`(select count(*)::int from ${commissionInvoiceLines} l where l.invoice_id = ${commissionInvoices.id})`,
    })
    .from(commissionInvoices)
    .innerJoin(organizations, eq(organizations.id, commissionInvoices.organizationId))
    .orderBy(desc(commissionInvoices.issuedAt));
  const payouts = await db
    .select({ payout: commissionPayouts, invoiceNumber: commissionInvoices.invoiceNumber, recordedBy: users.name })
    .from(commissionPayouts)
    .innerJoin(commissionInvoices, eq(commissionInvoices.id, commissionPayouts.invoiceId))
    .leftJoin(users, eq(users.id, commissionPayouts.recordedBy))
    .orderBy(desc(commissionPayouts.receivedAt))
    .limit(50);
  const [uninvoiced] = await db
    .select({ amount: sql<string>`coalesce(sum(${commissionEntries.amountMinor}), 0)`, n: sql<number>`count(*)::int` })
    .from(commissionEntries)
    .leftJoin(commissionInvoiceLines, eq(commissionInvoiceLines.commissionEntryId, commissionEntries.id))
    .where(sql`${commissionInvoiceLines.id} is null`);
  return {
    invoices: invoices.map((i) => ({ ...i, collected: Number(i.collected) })),
    payouts,
    uninvoiced: { amountMinor: Number(uninvoiced?.amount ?? 0), count: uninvoiced?.n ?? 0 },
  };
}

export async function listOrganizations(db: Database) {
  return db
    .select({
      org: organizations,
      payments: sql<number>`(select count(*)::int from ${paymentIntents} p where p.organization_id = ${organizations.id})`,
      users: sql<number>`(select count(*)::int from ${users} u where u.organization_id = ${organizations.id})`,
      activeRate: sql<number | null>`(select r.rate_ppm from ${commissionRules} r where r.organization_id = ${organizations.id} and r.status <> 'draft' and r.effective_from <= now() and (r.effective_to is null or r.effective_to > now()) order by r.version desc limit 1)`,
    })
    .from(organizations)
    .orderBy(asc(organizations.name));
}

export async function listSettlementBatchesAllTenants(db: Database) {
  return db
    .select({ batch: settlementBatches, organization: organizations.name })
    .from(settlementBatches)
    .innerJoin(organizations, eq(organizations.id, settlementBatches.organizationId))
    .orderBy(desc(settlementBatches.createdAt))
    .limit(30);
}

export async function listReversiblePayments(db: Database) {
  return db
    .select({ id: paymentIntents.id, reference: paymentIntents.reference, amountMinor: paymentIntents.amountMinor, customerName: paymentIntents.customerName, organization: organizations.name })
    .from(paymentIntents)
    .innerJoin(organizations, eq(organizations.id, paymentIntents.organizationId))
    .where(and(eq(paymentIntents.status, "successful")))
    .orderBy(desc(paymentIntents.createdAt))
    .limit(15);
}

/** The scripted 10,000 MZN demonstration scenario, if seeded. */
export async function getShowcase(db: Database) {
  const [p] = await db.select().from(paymentIntents).where(eq(paymentIntents.customerName, "Cenário Demo — Segurado Exemplo")).limit(1);
  if (!p) return null;
  const entries = await db.select().from(commissionEntries).where(eq(commissionEntries.paymentIntentId, p.id));
  const accrual = entries.find((e) => e.entryType === "accrual") ?? null;
  const inv = accrual
    ? await db
        .select({ invoice: commissionInvoices })
        .from(commissionInvoiceLines)
        .innerJoin(commissionInvoices, eq(commissionInvoices.id, commissionInvoiceLines.invoiceId))
        .where(eq(commissionInvoiceLines.commissionEntryId, accrual.id))
    : [];
  const invoice = inv[0]?.invoice ?? null;
  const payouts = invoice ? await db.select().from(commissionPayouts).where(eq(commissionPayouts.invoiceId, invoice.id)) : [];
  return { payment: p, accrual, invoice, payouts };
}
