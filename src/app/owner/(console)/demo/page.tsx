import Link from "next/link";
import { Banknote, Building2, ExternalLink, FlaskConical, Landmark, Lock, QrCode, Search, ShieldAlert, Wallet } from "lucide-react";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireOwnerPage } from "@/lib/auth/session";
import { listDemoTransactions } from "@/lib/demo/service";
import { getLifecycle, listTimeline } from "@/lib/lifecycle/service";
import { INSURER_STAGES, SMARTPAY_STAGES } from "@/lib/lifecycle/stages";
import { formatMzn } from "@/lib/money";
import { METHOD_LABELS, formatDateTime } from "@/lib/labels";
import { SCENARIOS } from "@/lib/settlement/scenarios";
import { PageHeader } from "@/components/layout/app-shell";
import { AutoRefresh } from "@/components/layout/auto-refresh";
import { ActionForm } from "@/components/dashboard/action-form";
import { ClosurePanel } from "@/components/dashboard/closure-panel";
import { StageDots, StageTracker } from "@/components/lifecycle/stage-tracker";
import { Timeline } from "@/components/lifecycle/timeline";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Input, NativeSelect } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";
import { demoCollectAction, demoInvoiceAction, demoPaymentEventAction, demoSettlementAction } from "../actions";

export const metadata = { title: "Demo Control Center" };

const qSchema = z.object({ id: z.string().uuid().optional().catch(undefined), q: z.string().max(60).optional().catch(undefined) });

export default async function DemoControlCenter({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireOwnerPage("platform:demo:control");
  const { id, q } = qSchema.parse(await searchParams);
  const db = getDb();
  const list = await listDemoTransactions(db, q, 20);
  const selectedId = id ?? list[0]?.id;
  const selected = list.find((t) => t.id === selectedId) ?? null;
  const [lifecycle, timeline] = selectedId ? await Promise.all([getLifecycle(db, selectedId), listTimeline(db, selectedId, "platform")]) : [null, []];
  const href = (o: { id?: string; q?: string }) => {
    const p = new URLSearchParams();
    if (o.q ?? q) p.set("q", (o.q ?? q)!);
    if (o.id) p.set("id", o.id);
    return `/owner/demo?${p.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Demo Control Center"
        description="Controlo privado da demonstração: dispara eventos simulados de pagamento, banco e cobrança e acompanha o ciclo completo"
        actions={
          <>
            <AutoRefresh intervalMs={5000} />
            <Button asChild variant="outline" size="sm">
              <Link href="/pay/demo/qr" target="_blank">
                <QrCode /> QR do cliente
              </Link>
            </Button>
          </>
        }
      />
      <Alert tone="warning" icon={<FlaskConical />} className="mb-4">
        Todos os eventos aqui são <strong>simulados</strong> e passam pelos mesmos serviços da aplicação (webhooks assinados, ledger, auditoria). A reconciliação, a alocação no
        KIT e o encerramento operacional <strong>não</strong> estão disponíveis aqui: são acções da equipa Finance da seguradora e o servidor recusa-as ao proprietário da
        plataforma.
      </Alert>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        {/* ---------------- transaction picker ---------------- */}
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Transacções</CardTitle>
            <CardDescription>Seleccione uma transacção. Novos pagamentos feitos no telemóvel aparecem aqui.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <form method="get" className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input name="q" defaultValue={q} placeholder="Referência ou segurado" className="pl-9" aria-label="Pesquisar transacção" />
            </form>
            <ul className="max-h-[640px] space-y-1.5 overflow-y-auto pr-1">
              {list.map((t) => (
                <li key={t.id}>
                  <Link
                    href={href({ id: t.id })}
                    aria-current={t.id === selectedId ? "true" : undefined}
                    className={cn("block rounded-lg border p-3 transition-colors hover:bg-muted/50", t.id === selectedId && "border-primary bg-primary-soft/40")}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-medium">{t.reference}</span>
                      <StatusBadge kind="payment" value={t.status} />
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {t.customerName} · {formatMzn(t.amountMinor)}
                    </p>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <StageDots stages={t.stages} />
                      <span className="text-[11px] text-muted-foreground">{formatDateTime(t.createdAt)}</span>
                    </div>
                  </Link>
                </li>
              ))}
              {list.length === 0 && <li className="text-sm text-muted-foreground">Sem resultados.</li>}
            </ul>
          </CardContent>
        </Card>

        {/* ---------------- selected transaction ---------------- */}
        {!selected || !lifecycle ? (
          <Card>
            <EmptyState icon={<Wallet />} title="Nenhuma transacção seleccionada" description="Faça um pagamento no portal do cliente ou seleccione uma transacção da lista." />
          </Card>
        ) : (
          <div className="min-w-0 space-y-4">
            <Card>
              <CardContent className="flex flex-wrap items-start justify-between gap-4 p-5">
                <div>
                  <p className="font-mono text-sm text-muted-foreground">{selected.reference}</p>
                  <p className="text-2xl font-semibold tracking-tight tabular">{formatMzn(selected.amountMinor)}</p>
                  <p className="text-sm text-muted-foreground">
                    {selected.customerName} · {METHOD_LABELS[selected.method]} · {selected.organization}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <StatusBadge kind="payment" value={selected.status} />
                  <Badge tone="warning">Simulado</Badge>
                </div>
              </CardContent>
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardContent className="p-5">
                  <StageTracker stages={lifecycle.stages.filter((s) => INSURER_STAGES.includes(s.key))} title="Processo operacional — seguradora" />
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-5">
                  <StageTracker stages={lifecycle.stages.filter((s) => SMARTPAY_STAGES.includes(s.key))} title="Processo financeiro — SmartPay" />
                </CardContent>
              </Card>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <DemoStep icon={<Wallet />} title="1 · Evento do fornecedor de pagamento" note="Webhook assinado pelo fornecedor simulado">
                {selected.status === "created" && (
                  <EventButtons
                    paymentId={selected.id}
                    events={[
                      ["approve", "Aprovar"],
                      ["pending", "Deixar pendente"],
                      ["insufficient_funds", "Saldo insuficiente"],
                      ["cancel", "Cancelar"],
                    ]}
                  />
                )}
                {selected.status === "pending" && (
                  <EventButtons
                    paymentId={selected.id}
                    events={[
                      ["resolve_approve", "Confirmar pagamento"],
                      ["resolve_decline", "Recusar"],
                      ["resolve_cancel", "Expirar"],
                    ]}
                  />
                )}
                {selected.status === "successful" && (
                  <ActionForm action={demoPaymentEventAction} submitLabel="Simular reversão (chargeback)" variant="destructive" confirm="Reverter este pagamento simulado?">
                    <input type="hidden" name="paymentId" value={selected.id} />
                    <input type="hidden" name="event" value="reverse" />
                    <p className="text-xs text-muted-foreground">Reabre os encerramentos, anula as alocações ainda não feitas e compensa a comissão no ledger.</p>
                  </ActionForm>
                )}
                {(selected.status === "failed" || selected.status === "cancelled" || selected.status === "reversed") && (
                  <p className="text-sm text-muted-foreground">Estado final do pagamento — sem eventos de pagamento disponíveis.</p>
                )}
              </DemoStep>

              <DemoStep icon={<Landmark />} title="2 · Liquidação bancária" note="O banco/fornecedor simulado credita a conta da seguradora">
                {selected.status === "successful" && lifecycle.facts.settlement.lines === 0 ? (
                  <ActionForm action={demoSettlementAction} submitLabel="Simular liquidação bancária">
                    <input type="hidden" name="paymentId" value={selected.id} />
                    <NativeSelect name="scenario" aria-label="Cenário de liquidação" defaultValue="gross">
                      {(["gross", "net", "separate_fee_debit", "aggregated"] as const).map((k) => (
                        <option key={k} value={k}>
                          {SCENARIOS[k].label}
                        </option>
                      ))}
                    </NativeSelect>
                    <p className="text-xs text-muted-foreground">O cenário agregado junta até 3 outros pagamentos por liquidar num único crédito bancário.</p>
                  </ActionForm>
                ) : selected.status === "reversed" ? (
                  <ActionForm action={demoSettlementAction} submitLabel="Simular débito de reversão">
                    <input type="hidden" name="paymentId" value={selected.id} />
                    <input type="hidden" name="scenario" value="reversal" />
                  </ActionForm>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {lifecycle.facts.settlement.lines > 0
                      ? lifecycle.facts.settlement.awaitingReconciliation
                        ? "Liquidação recebida — aguarda reconciliação pela equipa Finance."
                        : "Liquidação recebida e processada."
                      : "Disponível depois de o pagamento ser confirmado."}
                  </p>
                )}
              </DemoStep>

              <DemoStep icon={<Building2 />} title="3 · Reconciliação e alocação no KIT" note="Acção da equipa Finance da seguradora" finance>
                <ul className="space-y-1.5 text-sm">
                  <li>
                    Reconciliação: <strong>{lifecycle.stages.find((s) => s.key === "reconciliation")?.detail}</strong>
                  </li>
                  <li>
                    Alocação de Pagamentos: <strong>{lifecycle.stages.find((s) => s.key === "kit_allocation")?.detail}</strong>
                  </li>
                  <li>
                    Encerramento operacional: <strong>{lifecycle.facts.operationalClosure ? "encerrado" : lifecycle.canCloseOperational.ok ? "pronto para encerrar" : "em aberto"}</strong>
                  </li>
                </ul>
                <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <ShieldAlert className="mt-0.5 size-3.5 shrink-0" /> Execute estes passos no dispositivo da Finance, em Finance Dashboard → Reconciliação e Alocação de Pagamentos.
                </p>
              </DemoStep>

              <DemoStep icon={<Banknote />} title="4 · Comissão SmartPay" note="Apurar ≠ facturar ≠ receber">
                <p className="text-sm">
                  Apurada: <strong className="tabular">{formatMzn(lifecycle.facts.commission.accruedMinor)}</strong> · líquida{" "}
                  <strong className="tabular">{formatMzn(lifecycle.facts.commission.netMinor)}</strong>
                </p>
                <div className="flex flex-wrap gap-2">
                  {lifecycle.facts.commission.entries > lifecycle.facts.commission.invoicedEntries && lifecycle.facts.commission.netMinor > 0 && (
                    <ActionForm action={demoInvoiceAction} submitLabel="Emitir factura simulada" variant="outline">
                      <input type="hidden" name="paymentId" value={selected.id} />
                    </ActionForm>
                  )}
                  {lifecycle.facts.commission.invoicedEntries > lifecycle.facts.commission.paidEntries && (
                    <ActionForm action={demoCollectAction} submitLabel="Simular recebimento da comissão">
                      <input type="hidden" name="paymentId" value={selected.id} />
                    </ActionForm>
                  )}
                </div>
                {lifecycle.facts.commission.entries > 0 && lifecycle.facts.commission.paidEntries === lifecycle.facts.commission.entries && (
                  <p className="text-xs text-success">Comissão recebida (simulada).</p>
                )}
              </DemoStep>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Lock className="size-4" /> Encerramento financeiro SmartPay
                </CardTitle>
                <CardDescription>Independente do encerramento operacional da seguradora.</CardDescription>
              </CardHeader>
              <CardContent>
                <ClosurePanel
                  closed={!!lifecycle.facts.financialClosure}
                  canClose={lifecycle.canCloseFinancial.ok}
                  reasons={lifecycle.canCloseFinancial.reasons}
                  endpoint={`/api/owner/transactions/${selected.id}/financial-closure`}
                  closeLabel="Encerrar processo financeiro"
                  closedLabel={`Encerrado em ${lifecycle.facts.financialClosure ? formatDateTime(lifecycle.facts.financialClosure.closedAt) : ""}`}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
                <div>
                  <CardTitle>Linha temporal completa</CardTitle>
                  <CardDescription>Todos os eventos persistidos em PostgreSQL, das duas organizações</CardDescription>
                </div>
                <Button asChild variant="ghost" size="sm">
                  <Link href={`/pay/demo`} target="_blank">
                    <ExternalLink /> Portal do cliente
                  </Link>
                </Button>
              </CardHeader>
              <CardContent>
                <Timeline events={timeline} />
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </>
  );
}

function DemoStep({ icon, title, note, finance, children }: { icon: React.ReactNode; title: string; note: string; finance?: boolean; children: React.ReactNode }) {
  return (
    <Card className={cn(finance && "border-dashed bg-muted/30")}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 [&_svg]:size-4">
          {icon} {title}
        </CardTitle>
        <CardDescription>{note}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  );
}

function EventButtons({ paymentId, events }: { paymentId: string; events: [string, string][] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {events.map(([event, label], i) => (
        <ActionForm key={event} action={demoPaymentEventAction} submitLabel={label} variant={i === 0 ? "default" : "outline"} className="space-y-2">
          <input type="hidden" name="paymentId" value={paymentId} />
          <input type="hidden" name="event" value={event} />
        </ActionForm>
      ))}
    </div>
  );
}
