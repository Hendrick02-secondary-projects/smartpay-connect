import "server-only";
import { and, desc, eq, ilike, ne, or, sql } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { commissionEntries, commissionInvoiceLines, commissionInvoices, commissionPayouts, organizations, paymentIntents } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { issueInvoiceForPayment, recordCollection } from "@/lib/commission/service";
import { HttpError } from "@/lib/http";
import { loadFactsMany } from "@/lib/lifecycle/service";
import { deriveStages } from "@/lib/lifecycle/stages";
import type { MockPaymentProvider, MockScenario, PendingResolution } from "@/lib/payments/mock-provider";
import { reverseSimulatedPayment, runPendingResolution, runSimulatedCheckout } from "@/lib/payments/service";
import { generateSimulatedSettlement } from "@/lib/reconciliation/service";
import type { ScenarioKey } from "@/lib/settlement/scenarios";

/**
 * Demo Control Center — platform-owner tooling that drives SIMULATED external events
 * (provider, bank, commission collection) through the same services and signed-webhook
 * pipeline as the real flow. It deliberately exposes NO reconciliation, KIT allocation
 * or operational-closure actions: those belong to the tenant's Finance team.
 */

type Owner = { userId: string };

export type DemoPaymentEvent = MockScenario | `resolve_${PendingResolution}` | "reverse";

export async function listDemoTransactions(db: Database, q: string | undefined, limit = 25) {
  const term = q?.trim();
  const like = term ? `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%` : null;
  const rows = await db
    .select({
      id: paymentIntents.id,
      reference: paymentIntents.reference,
      customerName: paymentIntents.customerName,
      amountMinor: paymentIntents.amountMinor,
      method: paymentIntents.paymentMethod,
      status: paymentIntents.status,
      createdAt: paymentIntents.createdAt,
      organization: organizations.name,
      organizationId: organizations.id,
    })
    .from(paymentIntents)
    .innerJoin(organizations, eq(organizations.id, paymentIntents.organizationId))
    .where(like ? or(ilike(paymentIntents.reference, like), ilike(paymentIntents.customerName, like)) : undefined)
    .orderBy(desc(paymentIntents.createdAt))
    .limit(limit);
  const facts = await loadFactsMany(db, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, stages: deriveStages(facts.get(r.id)!) }));
}

async function loadIntent(db: Database, paymentId: string) {
  const [intent] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, paymentId)).limit(1);
  if (!intent) throw new HttpError(404, "not_found", "Transacção não encontrada.");
  return intent;
}

export async function demoPaymentEvent(db: Database, provider: MockPaymentProvider, paymentId: string, event: DemoPaymentEvent, owner: Owner) {
  const intent = await loadIntent(db, paymentId);
  await writeAudit(db, {
    organizationId: intent.organizationId,
    actorType: "user",
    actorUserId: owner.userId,
    action: "demo.payment_event",
    entityType: "payment_intent",
    entityId: intent.id,
    metadata: { event, from: intent.status, via: "demo_control_center", simulated: true },
  });
  if (event === "reverse") {
    return reverseSimulatedPayment(db, provider, intent.id, "Chargeback simulado no Demo Control Center", owner.userId);
  }
  if (event.startsWith("resolve_")) {
    return (await runPendingResolution(db, provider, intent, event.slice(8) as PendingResolution)).outcome;
  }
  if (intent.status !== "created") throw new HttpError(409, "invalid_state", "Este evento só se aplica a pagamentos ainda não submetidos ao fornecedor.");
  const r = await runSimulatedCheckout(db, provider, intent, event as MockScenario);
  return r.outcomes[r.outcomes.length - 1];
}

/**
 * Simulated bank settlement for one payment. "aggregated" bundles it with up to three
 * other unsettled payments of the same tenant into ONE bank credit. The batch is left
 * PENDING: reconciliation is a Finance action.
 */
export async function demoSettlement(db: Database, provider: MockPaymentProvider, paymentId: string, scenario: ScenarioKey, owner: Owner) {
  const intent = await loadIntent(db, paymentId);
  let paymentIds = [intent.id];
  if (scenario === "aggregated") {
    const others = await db
      .select({ id: paymentIntents.id })
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.organizationId, intent.organizationId),
          eq(paymentIntents.status, "successful"),
          eq(paymentIntents.reconciliationStatus, "unreconciled"),
          ne(paymentIntents.id, intent.id),
          sql`not exists (select 1 from bank_settlements bs where bs.organization_id = ${paymentIntents.organizationId} and bs.payment_reference = ${paymentIntents.reference} and not bs.is_duplicate_row)`,
        ),
      )
      .orderBy(desc(paymentIntents.createdAt))
      .limit(3);
    paymentIds = [intent.id, ...others.map((o) => o.id)];
  }
  const result = await generateSimulatedSettlement(db, provider, { organizationId: intent.organizationId, scenario, paymentIds, limit: paymentIds.length }, { userId: owner.userId });
  if (!result.lines) throw new HttpError(422, "nothing_to_settle", "Sem linhas geradas.");
  return result;
}

export async function demoInvoice(db: Database, paymentId: string, owner: Owner) {
  return issueInvoiceForPayment(db, { paymentIntentId: paymentId }, owner);
}

/** Records the SIMULATED receipt of the outstanding amount of every open invoice holding this payment's commission. */
export async function demoCollect(db: Database, paymentId: string, owner: Owner) {
  const invoices = await db
    .selectDistinct({ id: commissionInvoices.id, amountMinor: commissionInvoices.amountMinor, invoiceNumber: commissionInvoices.invoiceNumber })
    .from(commissionEntries)
    .innerJoin(commissionInvoiceLines, eq(commissionInvoiceLines.commissionEntryId, commissionEntries.id))
    .innerJoin(commissionInvoices, eq(commissionInvoices.id, commissionInvoiceLines.invoiceId))
    .where(and(eq(commissionEntries.paymentIntentId, paymentId), or(eq(commissionInvoices.status, "issued"), eq(commissionInvoices.status, "partially_paid"))));
  if (invoices.length === 0) throw new HttpError(422, "nothing_to_collect", "Não há factura em aberto com a comissão deste pagamento. Emita a factura primeiro.");
  const results = [];
  for (const inv of invoices) {
    const [paid] = await db
      .select({ total: sql<string>`coalesce(sum(${commissionPayouts.amountMinor}), 0)` })
      .from(commissionPayouts)
      .where(eq(commissionPayouts.invoiceId, inv.id));
    const outstanding = inv.amountMinor - Number(paid?.total ?? 0);
    if (outstanding <= 0) continue;
    results.push(
      await recordCollection(
        db,
        {
          invoiceId: inv.id,
          amountMinor: outstanding,
          receivedAt: new Date(),
          collectionReference: `DEMO-TRF-${inv.invoiceNumber.replace(/[^A-Z0-9]/g, "").slice(-10)}-${Date.now().toString(36).toUpperCase()}`,
          method: "bank_transfer",
          notes: "Recebimento simulado no Demo Control Center.",
        },
        owner,
      ),
    );
  }
  return results;
}
