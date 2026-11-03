import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { bankAccounts, organizations } from "@/lib/db/schema";
import { DemoBanner } from "@/components/layout/demo-banner";
import { PaymentFlow } from "@/components/payment/payment-flow";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ org: string }> }): Promise<Metadata> {
  const { org } = await params;
  const [row] = await getDb().select({ portalName: organizations.portalName }).from(organizations).where(eq(organizations.slug, org)).limit(1);
  return { title: row ? `${row.portalName} (demo)` : "Pagamento" };
}

export default async function PayPage({ params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const db = getDb();
  const [org] = await db
    .select({ id: organizations.id, slug: organizations.slug, portalName: organizations.portalName, isActive: organizations.isActive })
    .from(organizations)
    .where(eq(organizations.slug, slug))
    .limit(1);
  if (!org || !org.isActive) notFound();

  const accounts = await db
    .select({
      code: bankAccounts.code,
      bankName: bankAccounts.bankName,
      accountName: bankAccounts.accountName,
      accountNumberMasked: bankAccounts.accountNumberMasked,
      purpose: bankAccounts.purpose,
    })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.organizationId, org.id), eq(bankAccounts.isActive, true)))
    .orderBy(asc(bankAccounts.displayOrder));

  return (
    <div className="min-h-dvh bg-background">
      <DemoBanner />
      <PaymentFlow org={{ slug: org.slug, portalName: org.portalName }} accounts={accounts} />
    </div>
  );
}
