import Link from "next/link";
import { ArrowRight, BadgeCheck, CircleDollarSign, FileClock, Hourglass, Landmark, ListChecks, ReceiptText, Scale, SlidersHorizontal } from "lucide-react";
import { getDb } from "@/lib/db";
import { requireOwnerPage } from "@/lib/auth/session";
import { getOwnerCharts, getOwnerKpis, getShowcase } from "@/lib/queries/owner";
import { formatMzn, formatMznCompact, ppmToPercentString } from "@/lib/money";
import { METHOD_LABELS, formatDateTime } from "@/lib/labels";
import { PageHeader } from "@/components/layout/app-shell";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { DonutChart, GroupedMonthlyBars } from "@/components/charts/charts";
import { Button } from "@/components/ui/button";
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

export const metadata = { title: "Receita" };

export default async function OwnerDashboard() {
  await requireOwnerPage();
  const db = getDb();
  const [k, charts, showcase] = await Promise.all([getOwnerKpis(db), getOwnerCharts(db), getShowcase(db)]);

  return (
    <>
      <PageHeader
        title="Receita da plataforma"
        description="Todas as organizações · comissões acumuladas ≠ comissões cobradas"
        actions={
          <Button asChild variant="outline" size="sm">
            <a href="/api/owner/commissions/export">Exportar ledger (Excel)</a>
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Volume transaccionado" value={formatMznCompact(k.volumeMinor)} hint={formatMzn(k.volumeMinor)} icon={<Landmark />} />
        <KpiCard label="Transacções bem-sucedidas" value={k.successCount.toLocaleString("pt-MZ")} hint={`${k.reversedCount} revertidas`} icon={<BadgeCheck />} tone="success" />
        <KpiCard label="Comissão bruta acumulada" value={formatMzn(k.accrued)} icon={<CircleDollarSign />} tone="primary" />
        <KpiCard label="Ajustes e reversões" value={formatMzn(k.adjustments)} hint="Entradas compensatórias" icon={<SlidersHorizontal />} tone={k.adjustments < 0 ? "danger" : "default"} />
        <KpiCard label="Comissão líquida devida" value={formatMzn(k.netDue)} icon={<Scale />} />
        <KpiCard label="Facturado" value={formatMzn(k.invoiced)} hint={`${formatMzn(k.notYetInvoiced)} por facturar`} icon={<ReceiptText />} />
        <KpiCard label="Cobrado" value={formatMzn(k.collected)} hint="Só cobranças registadas" icon={<ListChecks />} tone="success" />
        <KpiCard label="Em dívida" value={formatMzn(k.outstanding)} hint="Líquido devido − cobrado" icon={<Hourglass />} tone="warning" />
      </div>

      {showcase && <ShowcaseCard s={showcase} />}

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Receita de comissões por mês</CardTitle>
            <CardDescription>Acumulada (bruta) vs líquida após ajustes/reversões</CardDescription>
          </CardHeader>
          <CardContent>
            <GroupedMonthlyBars
              data={charts.monthly}
              series={[
                { key: "accrued", label: "Acumulada", color: "var(--chart-1)" },
                { key: "net", label: "Líquida", color: "var(--chart-2)" },
              ]}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Cobrado vs em dívida</CardTitle>
            <CardDescription>Valores acumulados no fim de cada mês</CardDescription>
          </CardHeader>
          <CardContent>
            <GroupedMonthlyBars
              data={charts.monthly}
              series={[
                { key: "collectedCumulative", label: "Cobrado (acum.)", color: "var(--chart-3)" },
                { key: "outstandingCumulative", label: "Em dívida (acum.)", color: "var(--chart-4)" },
              ]}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Volume transaccionado por mês</CardTitle>
            <CardDescription>Pagamentos bem-sucedidos (simulados)</CardDescription>
          </CardHeader>
          <CardContent>
            <GroupedMonthlyBars data={charts.volume} series={[{ key: "volume", label: "Volume", color: "var(--chart-5)" }]} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Comissão por método de pagamento</CardTitle>
            <CardDescription>Líquida, por método</CardDescription>
          </CardHeader>
          <CardContent>
            <DonutChart data={charts.byMethod.map((m) => ({ label: METHOD_LABELS[m.method] ?? m.method, value: m.amount }))} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function ShowcaseCard({ s }: { s: NonNullable<Awaited<ReturnType<typeof getShowcase>>> }) {
  const collected = s.payouts.reduce((a, p) => a + p.amountMinor, 0);
  const steps = [
    { t: "Pagamento do cliente", d: `${formatMzn(s.payment.amountMinor)} · ${s.payment.status}`, at: s.payment.completedAt, done: s.payment.status === "successful" },
    { t: "Liquidação & reconciliação", d: s.payment.reconciliationStatus === "reconciled" ? "Liquidação simulada correspondida" : "Por reconciliar", at: null, done: s.payment.reconciliationStatus === "reconciled" },
    {
      t: "Comissão acumulada",
      d: s.accrual ? `${formatMzn(s.accrual.amountMinor)} (${ppmToPercentString(s.accrual.ratePpm ?? 0)}% · regra v${s.accrual.ruleVersion})` : "—",
      at: s.accrual?.createdAt ?? null,
      done: !!s.accrual,
    },
    { t: "Factura emitida", d: s.invoice ? `${s.invoice.invoiceNumber}` : "Ainda não facturada", at: s.invoice?.issuedAt ?? null, done: !!s.invoice },
    { t: "Comissão cobrada", d: collected ? `${formatMzn(collected)} recebidos` : "Ainda não cobrada", at: s.payouts[0]?.receivedAt ?? null, done: collected > 0 },
  ];
  return (
    <Card className="mt-4 overflow-hidden">
      <CardHeader className="bg-primary-soft/50">
        <CardTitle className="flex items-center gap-2">
          <FileClock className="size-4" /> Cenário de demonstração — 10 000 MZN a 0,5%
        </CardTitle>
        <CardDescription>
          Ref. <span className="font-mono">{s.payment.reference}</span> — mostra que acumular uma comissão e cobrá-la são eventos diferentes.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-5">
        <ol className="grid gap-3 md:grid-cols-5">
          {steps.map((st, i) => (
            <li key={st.t} className={cn("relative rounded-lg border p-3", st.done ? "border-success/40 bg-success-soft/40" : "border-dashed")}>
              <span className={cn("flex size-6 items-center justify-center rounded-full text-xs font-bold", st.done ? "bg-success text-white" : "bg-muted text-muted-foreground")}>{i + 1}</span>
              <p className="mt-2 text-sm font-semibold">{st.t}</p>
              <p className="text-xs text-muted-foreground">{st.d}</p>
              {st.at && <p className="mt-1 text-[11px] text-muted-foreground">{formatDateTime(st.at)}</p>}
              {i < steps.length - 1 && <ArrowRight className="absolute -right-3 top-1/2 hidden size-4 -translate-y-1/2 text-muted-foreground md:block" />}
            </li>
          ))}
        </ol>
        <Alert tone="info" className="mt-4">
          Esperado: 1 000 000 centavos × 5 000 ppm ÷ 1 000 000 = <strong>5 000 centavos = 50,00 MZN</strong>. A comissão foi acumulada no momento em que o pagamento ficou
          elegível; só passa a «cobrada» quando a cobrança é registada contra a factura.{" "}
          <Link href="/owner/invoices" className="font-medium underline">
            Ver facturas
          </Link>
        </Alert>
      </CardContent>
    </Card>
  );
}
