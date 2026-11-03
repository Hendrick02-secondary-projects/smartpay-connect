import type { Metadata } from "next";
import { AppShell } from "@/components/layout/app-shell";
import { requireOwnerPage } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: { default: "Consola SmartPay", template: "%s · Consola SmartPay (demo)" },
  robots: { index: false, follow: false },
};

export default async function OwnerLayout({ children }: { children: React.ReactNode }) {
  const principal = await requireOwnerPage();
  return (
    <AppShell
      area="Consola da plataforma"
      areaLabel="SmartPay"
      logoutTo="owner"
      user={{ name: principal.name, email: principal.email, roleLabel: "Proprietário da plataforma" }}
      nav={[
        { href: "/owner/dashboard", label: "Receita", icon: "dashboard" },
        { href: "/owner/demo", label: "Demo Control Center", icon: "demo" },
        { href: "/owner/commissions", label: "Ledger de comissões", icon: "ledger" },
        { href: "/owner/invoices", label: "Facturas e cobranças", icon: "invoices" },
        { href: "/owner/settings", label: "Regras de comissão", icon: "rules" },
        { href: "/owner/settlements", label: "Liquidações e taxas", icon: "settlements" },
        { href: "/owner/organizations", label: "Organizações", icon: "orgs" },
      ]}
    >
      {children}
    </AppShell>
  );
}
