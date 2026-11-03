import Link from "next/link";
import { ArrowRight, BarChart3, QrCode, ShieldCheck, Smartphone } from "lucide-react";
import { DemoBanner } from "@/components/layout/demo-banner";
import { SmartPayLogo } from "@/components/layout/brand";
import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <div className="min-h-dvh">
      <DemoBanner />
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
        <SmartPayLogo />
        <Button asChild variant="ghost" size="sm">
          <Link href="/login">Área financeira</Link>
        </Button>
      </header>
      <main className="mx-auto max-w-6xl px-5 pb-20 pt-10">
        <div className="max-w-2xl">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Versão 1.0 · Demonstração</p>
          <h1 className="mt-3 text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
            Pagamentos por QR code, identificados e reconciliados de ponta a ponta.
          </h1>
          <p className="mt-5 text-lg text-muted-foreground">
            O SmartPay Connect substitui o fluxo do POS físico por pagamentos digitais iniciados por QR code — com identificação do segurado, notas de
            débito, reconciliação bancária e relatórios. Esta demonstração usa um gateway simulado.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link href="/pay/demo">
                Abrir portal SmartPay Payments (demo) <ArrowRight />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/pay/demo/qr">
                <QrCode /> Ver QR code
              </Link>
            </Button>
          </div>
        </div>
        <div className="mt-16 grid gap-4 sm:grid-cols-3">
          {[
            { icon: <Smartphone />, t: "Experiência móvel", d: "Cartão, M-Pesa e e-Mola num fluxo de 6 passos, com várias notas de débito por pagamento." },
            { icon: <BarChart3 />, t: "Reconciliação", d: "Confirmação de pagamento e reconciliação bancária são etapas distintas, com auditoria." },
            { icon: <ShieldCheck />, t: "Segurança", d: "RBAC no servidor, isolamento por organização, ledger imutável e idempotência." },
          ].map((f) => (
            <div key={f.t} className="rounded-xl border bg-card p-5">
              <span className="flex size-9 items-center justify-center rounded-lg bg-primary-soft text-primary [&_svg]:size-[18px]">{f.icon}</span>
              <h2 className="mt-4 text-sm font-semibold">{f.t}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{f.d}</p>
            </div>
          ))}
        </div>
        <p className="mt-16 text-xs text-muted-foreground">
          A demonstração usa uma seguradora fictícia (Demo Insurance Company). Nenhum pagamento real é processado; nenhum fornecedor de pagamentos
          real é contactado.
        </p>
      </main>
    </div>
  );
}
