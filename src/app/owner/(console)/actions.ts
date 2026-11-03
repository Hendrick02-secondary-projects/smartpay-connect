"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { requireOwnerApi } from "@/lib/auth/session";
import { createAdjustment, createRuleVersion, issueInvoice, recordCollection } from "@/lib/commission/service";
import { HttpError } from "@/lib/http";
import { parseMznToMinor, percentToPpm } from "@/lib/money";
import { getPaymentProvider } from "@/lib/payments/registry";
import { reverseSimulatedPayment } from "@/lib/payments/service";
import { demoCollect, demoInvoice, demoPaymentEvent, demoSettlement } from "@/lib/demo/service";

export interface ActionState {
  ok?: string;
  error?: string;
}

/**
 * Every owner Server Action re-checks the platform-owner role on the server
 * (Server Actions are public HTTP endpoints — the UI hiding them is not a control).
 */
async function run(fn: () => Promise<string>, paths: string[]): Promise<ActionState> {
  try {
    const ok = await fn();
    paths.forEach((p) => revalidatePath(p));
    return { ok };
  } catch (err) {
    if (err instanceof HttpError) return { error: err.message };
    if (err instanceof z.ZodError) return { error: err.issues[0]?.message ?? "Dados inválidos." };
    console.error("[smartpay] owner action failed:", err instanceof Error ? err.message : "unknown");
    return { error: "Ocorreu um erro inesperado." };
  }
}

const ruleSchema = z.object({
  organizationId: z.string().uuid(),
  percent: z.string().transform((v, ctx) => {
    const ppm = percentToPpm(v);
    if (ppm === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Percentagem inválida (ex.: 0.5)." });
      return z.NEVER;
    }
    return ppm;
  }),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Data de início inválida."),
  effectiveTo: z.string().optional(),
  contractReference: z.string().trim().min(3, "Indique a referência do contrato.").max(80),
  notes: z.string().trim().max(500).optional(),
});

export async function createRuleAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const owner = await requireOwnerApi("platform:commission:write");
    const input = ruleSchema.parse(Object.fromEntries(fd.entries()));
    const from = new Date(`${input.effectiveFrom}:00+02:00`);
    const to = input.effectiveTo ? new Date(`${input.effectiveTo}:00+02:00`) : null;
    const rule = await createRuleVersion(
      getDb(),
      { organizationId: input.organizationId, ratePpm: input.percent, effectiveFrom: from, effectiveTo: to, contractReference: input.contractReference, notes: input.notes },
      { userId: owner.userId },
    );
    return `Versão ${rule.version} criada. Comissões já registadas não foram alteradas.`;
  }, ["/owner/settings", "/owner/dashboard"]);
}

const adjustmentSchema = z.object({
  organizationId: z.string().uuid(),
  direction: z.enum(["credit", "debit"]),
  amount: z.string(),
  reason: z.string().trim().min(10, "Indique um motivo (mín. 10 caracteres).").max(500),
});

export async function createAdjustmentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const owner = await requireOwnerApi("platform:commission:write");
    const input = adjustmentSchema.parse(Object.fromEntries(fd.entries()));
    const minor = parseMznToMinor(input.amount);
    if (!minor) throw new HttpError(422, "invalid_amount", "Valor inválido.");
    await createAdjustment(
      getDb(),
      { organizationId: input.organizationId, paymentIntentId: null, amountMinor: input.direction === "debit" ? -minor : minor, reason: input.reason },
      { userId: owner.userId },
    );
    return "Ajuste registado como nova entrada no ledger (entradas anteriores intactas).";
  }, ["/owner/commissions", "/owner/dashboard"]);
}

const invoiceSchema = z.object({
  organizationId: z.string().uuid(),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function issueInvoiceAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const owner = await requireOwnerApi("platform:commission:write");
    const input = invoiceSchema.parse(Object.fromEntries(fd.entries()));
    const inv = await issueInvoice(getDb(), input, { userId: owner.userId });
    return `Factura simulada ${inv.invoiceNumber} emitida.`;
  }, ["/owner/invoices", "/owner/dashboard", "/owner/commissions"]);
}

const collectionSchema = z.object({
  invoiceId: z.string().uuid(),
  amount: z.string(),
  receivedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  collectionReference: z.string().trim().min(3).max(80),
  method: z.enum(["bank_transfer", "netting", "other"]),
  notes: z.string().trim().max(500).optional(),
});

export async function recordCollectionAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const owner = await requireOwnerApi("platform:commission:write");
    const input = collectionSchema.parse(Object.fromEntries(fd.entries()));
    const minor = parseMznToMinor(input.amount);
    if (!minor) throw new HttpError(422, "invalid_amount", "Valor inválido.");
    const r = await recordCollection(
      getDb(),
      {
        invoiceId: input.invoiceId,
        amountMinor: minor,
        receivedAt: new Date(`${input.receivedAt}T12:00:00+02:00`),
        collectionReference: input.collectionReference.toUpperCase(),
        method: input.method,
        notes: input.notes,
      },
      { userId: owner.userId },
    );
    return `Cobrança registada. Estado da factura: ${r.status}.`;
  }, ["/owner/invoices", "/owner/dashboard", "/owner/commissions"]);
}

export async function reversePaymentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const owner = await requireOwnerApi("platform:organizations:manage");
    const input = z.object({ paymentId: z.string().uuid(), reason: z.string().trim().min(10, "Motivo: mín. 10 caracteres.").max(300) }).parse(Object.fromEntries(fd.entries()));
    const outcome = await reverseSimulatedPayment(getDb(), getPaymentProvider(), input.paymentId, input.reason, owner.userId);
    return outcome?.result === "processed" ? "Reversão simulada processada — comissão compensada no ledger." : `Evento ${outcome?.result ?? "?"}.`;
  }, ["/owner/settlements", "/owner/dashboard", "/owner/commissions"]);
}

export async function toggleOrganizationAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const owner = await requireOwnerApi("platform:organizations:manage");
    const id = z.string().uuid().parse(fd.get("organizationId"));
    const db = getDb();
    const [org] = await db.select().from(organizations).where(eq(organizations.id, id));
    if (!org) throw new HttpError(404, "not_found", "Organização não encontrada.");
    await db.update(organizations).set({ isActive: !org.isActive }).where(eq(organizations.id, id));
    await writeAudit(db, {
      organizationId: id,
      actorType: "user",
      actorUserId: owner.userId,
      action: org.isActive ? "organization.deactivated" : "organization.activated",
      entityType: "organization",
      entityId: id,
    });
    return org.isActive ? "Portal de pagamento desactivado." : "Portal de pagamento activado.";
  }, ["/owner/organizations"]);
}

// ------------------------------------------------------------------ V1.1 Demo Control Center
// Owner-only SIMULATED external events. Reconciliation and KIT allocation are NOT here:
// they require tenant permissions the owner does not have (see src/lib/auth/policy.ts).

const demoTarget = z.object({ paymentId: z.string().uuid() });

export async function demoPaymentEventAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const owner = await requireOwnerApi("platform:demo:control");
    const { paymentId, event } = demoTarget
      .extend({ event: z.enum(["approve", "decline", "insufficient_funds", "pending", "cancel", "resolve_approve", "resolve_decline", "resolve_cancel", "reverse"]) })
      .parse(Object.fromEntries(fd.entries()));
    const outcome = await demoPaymentEvent(getDb(), getPaymentProvider(), paymentId, event, { userId: owner.userId });
    return outcome && "result" in outcome && outcome.result === "processed"
      ? `Evento do fornecedor processado (${outcome.from} → ${outcome.to}).`
      : `Evento enviado: ${outcome && "result" in outcome ? outcome.result : "sem alteração"}.`;
  }, ["/owner/demo"]);
}

export async function demoSettlementAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const owner = await requireOwnerApi("platform:demo:control");
    const { paymentId, scenario } = demoTarget
      .extend({ scenario: z.enum(["gross", "net", "separate_fee_debit", "aggregated", "reversal"]) })
      .parse(Object.fromEntries(fd.entries()));
    const r = await demoSettlement(getDb(), getPaymentProvider(), paymentId, scenario, { userId: owner.userId });
    return `Liquidação simulada ${r.batch.batchReference} recebida (${r.lines} linha(s), ${r.payments} pagamento(s)). Aguarda reconciliação pela equipa Finance.`;
  }, ["/owner/demo"]);
}

export async function demoInvoiceAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const owner = await requireOwnerApi("platform:commission:write");
    const { paymentId } = demoTarget.parse(Object.fromEntries(fd.entries()));
    const inv = await demoInvoice(getDb(), paymentId, { userId: owner.userId });
    return `Factura simulada ${inv.invoiceNumber} emitida (${inv.amountMinor / 100} MZN).`;
  }, ["/owner/demo", "/owner/invoices"]);
}

export async function demoCollectAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const owner = await requireOwnerApi("platform:commission:write");
    const { paymentId } = demoTarget.parse(Object.fromEntries(fd.entries()));
    const results = await demoCollect(getDb(), paymentId, { userId: owner.userId });
    return results.length ? `Recebimento simulado registado — factura ${results.map((r) => r.status).join(", ")}.` : "Nada em dívida.";
  }, ["/owner/demo", "/owner/invoices"]);
}
