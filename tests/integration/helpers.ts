import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import * as s from "@/lib/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { MockPaymentProvider } from "@/lib/payments/mock-provider";

export const hasDb = !!process.env.TEST_DATABASE_URL;

export const provider = () => new MockPaymentProvider(process.env.MOCK_WEBHOOK_SECRET ?? "test-mock-webhook-secret");

/** Wipes all data between tests (TRUNCATE does not fire the append-only row triggers). */
export async function truncateAll() {
  await getDb().execute(sql`
    TRUNCATE lifecycle_events, payment_closures, kit_allocations, audit_logs, commission_payouts, commission_invoice_lines, commission_invoices, commission_entries,
      commission_rules, reconciliation_records, bank_settlements, settlement_batches, payment_events,
      payment_transactions, payment_debit_notes, payment_intents, bank_accounts, sessions, rate_limits,
      user_roles, users, organizations RESTART IDENTITY CASCADE`);
}

export interface Tenant {
  orgId: string;
  slug: string;
  accountCode: string;
  financeEmail: string;
  financeUserId: string;
}

export const PASSWORD = "Test#Password2026";

export async function createTenant(slug: string, ratePpm = 5_000): Promise<Tenant> {
  const db = getDb();
  const [org] = await db.insert(s.organizations).values({ slug, name: `${slug} demo`, portalName: `${slug} Payments` }).returning();
  const accountCode = `${slug.toUpperCase().slice(0, 6)}-01`;
  await db.insert(s.bankAccounts).values({
    organizationId: org!.id,
    code: accountCode,
    bankName: "Banco Teste",
    accountName: "Conta teste",
    accountNumberMasked: "TEST •••• 0001",
    purpose: "Teste",
  });
  const financeEmail = `finance@${slug}.test`;
  const [u] = await db.insert(s.users).values({ organizationId: org!.id, email: financeEmail, name: "Finance", passwordHash: await hashPassword(PASSWORD) }).returning();
  await db.insert(s.userRoles).values({ userId: u!.id, role: "finance_user", organizationId: org!.id });
  await db.insert(s.commissionRules).values({
    organizationId: org!.id,
    version: 1,
    ratePpm,
    effectiveFrom: new Date("2020-01-01T00:00:00Z"),
    status: "active",
    contractReference: `CTR-${slug}`,
  });
  return { orgId: org!.id, slug, accountCode, financeEmail, financeUserId: u!.id };
}

export async function createOwner() {
  const db = getDb();
  const [u] = await db.insert(s.users).values({ email: "owner@platform.test", name: "Owner", passwordHash: await hashPassword(PASSWORD) }).returning();
  await db.insert(s.userRoles).values({ userId: u!.id, role: "platform_owner", organizationId: null });
  return { userId: u!.id, email: "owner@platform.test" };
}

/** Raw (unparsed) public form input — amounts are strings as typed by the customer. */
export function paymentInput(t: Tenant, over: Partial<{ phone: string; method: "card" | "mpesa" | "emola"; notes: { number: string; amount: string }[]; key: string }> = {}) {
  return {
    idempotencyKey: over.key ?? randomUUID(),
    bankAccountCode: t.accountCode,
    customerName: "Ana Machava",
    customerPhone: over.phone ?? "+258841234567",
    method: over.method ?? ("card" as const),
    debitNotes: over.notes ?? [
      { number: "DN-1001", amount: "6500" },
      { number: "DN-1002", amount: "3500" },
    ],
  };
}
