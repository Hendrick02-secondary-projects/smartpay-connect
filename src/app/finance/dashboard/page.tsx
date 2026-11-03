import Link from "next/link";
import { AlertTriangle, ArrowLeftRight, CheckCircle2, Clock3, FileCheck2, Hourglass, Percent, Scale, Wallet, XCircle } from "lucide-react";
import { getDb } from "@/lib/db";
import { requireTenantPage } from "@/lib/auth/session";
import { getDashboardData } from "@/lib/queries/finance";
import { formatMzn, formatMznCompact } from "@/lib/money";
import { METHOD_LABELS, formatDateTime } from "@/lib/labels";
import { PageHeader } from "@/components/layout/app-shell";
import { AutoRefresh } from "@/components/layout/auto-refresh";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { DonutChart, HorizontalAmountBars, SuccessFailChart, VolumeChart } from "@/components/charts/charts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, TBody, THead, TR, Table } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/status-badge";

export const metadata = { title: "Visão geral" };

export default async function DashboardPage() {
  const { organizationId } = await requireTenantPage();
  const d = await getDashboardData(getDb(), organizationId, 90);
  const k = d.kpis;

  return (
    <>
      <PageHeader
        title="Visão geral"
        description="Últimos 90 dias · todos os valores são simulados"
        actions={
          <>
            <AutoRefresh intervalMs={15000} />
            <Button asChild variant="outline" size="sm">
              <Link href="/finance/transactions">
                <ArrowLeftRight /> Ver transacções
              </Link>
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Pagamentos simulados" value={k.total.toLocaleString("pt-MZ")} hint="Todas as intenções criadas" icon={<ArrowLeftRight />} />
        <KpiCard label="Total pago (simulado)" value={formatMznCompact(k.paidMinor)} hint={formatMzn(k.paidMinor)} icon={<Wallet />} tone="primary" />
        <KpiCard label="Bem-sucedidos" value={k.successful.toLocaleString("pt-MZ")} icon={<CheckCircle2 />} tone="success" />
        <KpiCard label="Pendentes" value={k.pending.toLocaleString("pt-MZ")} icon={<Clock3 />} tone="warning" />
        <KpiCard label="Falhados / cancelados" value={k.failed.toLocaleString("pt-MZ")} hint={`${k.reversed} revertidos`} icon={<XCircle />} tone="danger" />
        <KpiCard label="Por reconciliar" value={formatMznCompact(k.awaitingReconMinor)} hint="Bem-sucedidos sem liquidação correspondida" icon={<Hourglass />} tone="warning" />
        <KpiCard label="Reconciliado" value={formatMznCompact(k.reconciledMinor)} hint="Confirmado por liquidação bancária" icon={<Scale />} tone="success" />
        <KpiCard label="Taxa de sucesso" value={`${(k.successRate * 100).toFixed(1).replace(".", ",")}%`} hint="Sobre pagamentos concluídos" icon={<Percent />} />
      </div>

      <Card className="mt-4">
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>Funil operacional</CardTitle>
            <CardDescription>Pagamentos bem-sucedidos nos últimos 90 dias, por etapa do processo da seguradora</CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            {d.pendingBatches > 0 && (
              <Button asChild size="sm" variant="outline">
                <Link href="/finance/reconciliation">{d.pendingBatches} lote(s) por reconciliar</Link>
              </Button>
            )}
            <Button asChild size="sm">
              <Link href="/finance/allocations">
                <FileCheck2 /> {d.kit.pendingNotes} ND(s) por alocar
              </Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ol className="grid grid-cols-1 gap-2 sm:grid-cols-5">
            {[
              { label: "Pagamento confirmado", n: d.funnel.confirmed },
              { label: "Liquidação recebida", n: d.funnel.settled },
              { label: "Reconciliado", n: d.funnel.reconciled },
              { label: "Totalmente alocado no KIT", n: d.funnel.allocated },
              { label: "Encerrado (seguradora)", n: d.funnel.closed },
            ].map((step, i) => (
              <li key={step.label} className="rounded-lg border p-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  {i + 1}. {step.label}
                </p>
                <p className="mt-1 text-xl font-semibold tabular">{step.n}</p>
                <div className="mt-2 h-1.5 rounded-full bg-muted">
                  <div className="h-1.5 rounded-full bg-primary" style={{ width: `${d.funnel.confirmed ? Math.round((step.n / d.funnel.confirmed) * 100) : 0}%` }} />
                </div>
              </li>
            ))}
          </ol>
          {(d.kit.issues > 0 || d.kit.toVoid > 0) && (
            <p className="mt-3 text-xs text-danger">
              {d.kit.issues > 0 && `${d.kit.issues} ND(s) com problema de alocação. `}
              {d.kit.toVoid > 0 && `${d.kit.toVoid} alocação(ões) a anular no KIT por pagamentos revertidos.`}
            </p>
          )}
        </CardContent>
      </Card>

      {k.total === 0 ? (
        <Card className="mt-6">
          <EmptyState
            icon={<ArrowLeftRight />}
            title="Ainda não há pagamentos"
            description="Quando os segurados pagarem através do portal (QR code), os pagamentos simulados aparecem aqui."
            action={
              <Button asChild>
                <Link href="/pay/demo">Abrir portal de pagamento</Link>
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <div className="mt-6 grid gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader>
                <CardTitle>Volume de transacções</CardTitle>
                <CardDescription>Valor de pagamentos bem-sucedidos por dia (MZN)</CardDescription>
              </CardHeader>
              <CardContent>
                <VolumeChart data={d.daily} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Estado da reconciliação</CardTitle>
                <CardDescription>Pagamentos bem-sucedidos/revertidos por estado</CardDescription>
              </CardHeader>
              <CardContent>
                <DonutChart
                  data={d.byRecon.map((r) => ({
                    label: { unreconciled: "Por reconciliar", reconciled: "Reconciliado", exception: "Excepção", manually_reconciled: "Manual" }[r.state] ?? r.state,
                    value: r.amountMinor,
                    color: { unreconciled: "var(--chart-4)", reconciled: "var(--chart-3)", exception: "var(--danger)", manually_reconciled: "var(--chart-2)" }[r.state],
                  }))}
                />
                {(d.byRecon.find((r) => r.state === "exception")?.count ?? 0) > 0 && (
                  <Link href="/finance/reconciliation" className="mt-4 flex items-center gap-2 rounded-md bg-danger-soft px-3 py-2 text-xs font-medium text-danger">
                    <AlertTriangle className="size-3.5" /> {d.byRecon.find((r) => r.state === "exception")?.count} pagamentos com excepções — rever
                  </Link>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle>Valor por método</CardTitle>
                <CardDescription>Pagamentos bem-sucedidos</CardDescription>
              </CardHeader>
              <CardContent>
                <DonutChart data={d.byMethod.map((m) => ({ label: METHOD_LABELS[m.method] ?? m.method, value: m.amountMinor }))} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Por conta de destino</CardTitle>
                <CardDescription>Contas fictícias de demonstração</CardDescription>
              </CardHeader>
              <CardContent>
                <HorizontalAmountBars data={d.byAccount.map((a) => ({ label: a.purpose, amountMinor: a.amountMinor }))} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Sucesso vs falha</CardTitle>
                <CardDescription>Número de pagamentos por dia</CardDescription>
              </CardHeader>
              <CardContent>
                <SuccessFailChart data={d.daily} />
              </CardContent>
            </Card>
          </div>

          <Card className="mt-4">
            <CardHeader className="flex-row items-center justify-between">
              <div>
                <CardTitle>Pagamentos recentes</CardTitle>
                <CardDescription>Os 6 mais recentes</CardDescription>
              </div>
              <Button asChild variant="ghost" size="sm">
                <Link href="/finance/transactions">Ver todos</Link>
              </Button>
            </CardHeader>
            <Table>
              <THead>
                <tr>
                  <th>Referência</th>
                  <th>Segurado</th>
                  <th className="text-right">Valor</th>
                  <th>Método</th>
                  <th>Estado</th>
                  <th>Data</th>
                </tr>
              </THead>
              <TBody>
                {d.recent.map((t) => (
                  <TR key={t.id}>
                    <td>
                      <Link href={`/finance/transactions/${t.id}`} className="font-mono text-xs font-medium text-primary hover:underline">
                        {t.reference}
                      </Link>
                    </td>
                    <td className="max-w-48 truncate">{t.customerName}</td>
                    <td className="text-right font-medium tabular">{formatMzn(t.amountMinor)}</td>
                    <td className="whitespace-nowrap text-muted-foreground">{METHOD_LABELS[t.method]}</td>
                    <td>
                      <StatusBadge kind="payment" value={t.status} />
                    </td>
                    <td className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(t.createdAt)}</td>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Card>
        </>
      )}
    </>
  );
}
