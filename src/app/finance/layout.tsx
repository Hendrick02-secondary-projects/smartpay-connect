import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { AppShell } from "@/components/layout/app-shell";
import { requireTenantPage } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { organizations } from "@/lib/db/schema";

export const metadata: Metadata = { title: { default: "SmartPay Finance Dashboard", template: "%s · Finance Dashboard (demo)" } };

export default async function FinanceLayout({ children }: { children: React.ReactNode }) {
  // Authorisation is enforced on the server for the whole tenant area.
  const { principal, organizationId } = await requireTenantPage();
  // The insurer's name comes from its organisation record — no tenant is hard-coded.
  const [org] = await getDb().select({ name: organizations.name, isDemo: organizations.isDemo }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
  return (
    <AppShell
      area={`${org?.name ?? "Organização"}${org?.isDemo ? " · demo" : ""}`}
      areaLabel="Finance Dashboard"
      logoutTo="tenant"
      user={{ name: principal.name, email: principal.email, roleLabel: "Utilizador financeiro" }}
      nav={[
        { href: "/finance/dashboard", label: "Visão geral", icon: "dashboard" },
        { href: "/finance/transactions", label: "Transacções", icon: "transactions" },
        { href: "/finance/reconciliation", label: "Reconciliação", icon: "reconciliation" },
        { href: "/finance/allocations", label: "Alocação de Pagamentos", icon: "kit" },
      ]}
    >
      {children}
    </AppShell>
  );
}
