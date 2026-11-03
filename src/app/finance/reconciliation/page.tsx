import Link from "next/link";
import { ChevronLeft, ChevronRight, Inbox, Landmark } from "lucide-react";
import { getDb } from "@/lib/db";
import { requireTenantPage } from "@/lib/auth/session";
import { getReconciliationData, PAGE_SIZE, reconFiltersSchema } from "@/lib/queries/finance";
import { formatMzn } from "@/lib/money";
import { formatDate, formatDateTime } from "@/lib/labels";
import { REASON_LABELS, type ReasonCode } from "@/lib/reconciliation/matcher";
import { PageHeader } from "@/components/layout/app-shell";
import { ReconActions } from "@/components/dashboard/recon-actions";
import { ReviewDialog } from "@/components/dashboard/review-dialog";
import { ReconcileBatchButton } from "@/components/dashboard/reconcile-batch-button";
import { AutoRefresh } from "@/components/layout/auto-refresh";
import { FEE_TREATMENT_LABELS, SCENARIOS, type FeeTreatment, type ScenarioKey } from "@/lib/settlement/scenarios";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, TBody, THead, TR, Table } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";

export const metadata = { title: "Reconciliação" };

const TABS = [
  { key: "exceptions", label: "Excepções" },
  { key: "matched", label: "Correspondidos" },
  { key: "manually_reconciled", label: "Resolvidos" },
  { key: "rejected", label: "Rejeitados" },
] as const;

export default async function ReconciliationPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { organizationId } = await requireTenantPage("tenant:reconciliation:write");
  const f = reconFiltersSchema.parse(await searchParams);
  const d = await getReconciliationData(getDb(), organizationId, f);
  const exceptionsCount = ["unmatched", "amount_mismatch", "duplicate_settlement", "under_review"].reduce((a, s) => a + (d.statusCounts[s] ?? 0), 0);
  const pages = Math.max(1, Math.ceil(d.total / PAGE_SIZE));
  const link = (o: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    const m = { status: f.status, batch: f.batch, page: f.page, ...o };
    Object.entries(m).forEach(([k, v]) => v !== undefined && !(k === "page" && v === 1) && p.set(k, String(v)));
    return `/finance/reconciliation?${p.toString()}`;
  };

  return (
    <>
      <PageHeader title="Reconciliação bancária" description="Liquidações simuladas · confirmação de pagamento ≠ reconciliação bancária" actions={<AutoRefresh />} />

      <Alert tone="warning" className="mb-4">
        Todas as liquidações nesta versão são <strong>simuladas</strong>. Nenhum extracto bancário real é lido e o sistema KIT da seguradora não está integrado (V1).
      </Alert>

      {d.pendingBatches.length > 0 && (
        <Card className="mb-4 border-primary/40">
          <CardHeader>
            <CardTitle>Lotes por reconciliar ({d.pendingBatches.length})</CardTitle>
            <CardDescription>Liquidações recebidas do fornecedor simulado. A reconciliação é feita pela equipa Finance.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {d.pendingBatches.map(({ batch: b }) => (
              <div key={b.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
                <div className="min-w-0">
                  <p className="font-mono text-xs font-medium">{b.batchReference}</p>
                  <p className="text-xs text-muted-foreground">
                    {SCENARIOS[b.scenario as ScenarioKey]?.label ?? b.scenario} · {b.rowCount} linha(s) · {formatMzn(b.totalGrossMinor)} · {formatDateTime(b.createdAt)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button asChild variant="ghost" size="sm">
                    <Link href={link({ batch: b.id, status: "exceptions", page: 1 })}>Ver linhas</Link>
                  </Button>
                  <ReconcileBatchButton batchId={b.id} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <ReconActions />

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>{f.batch ? "Movimentos do lote seleccionado" : "Movimentos de liquidação (todos os lotes)"}</CardTitle>
          <CardDescription>Três coisas separadas: o que entra/sai na conta da seguradora, a taxa do gateway e a comissão SmartPay. Tudo simulado.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="rounded-lg border p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Conta bancária da seguradora</p>
              <p className="mt-2 text-xl font-semibold tabular">{formatMzn(d.movements.net)}</p>
              <p className="text-xs text-muted-foreground">
                {d.movements.bankMovements} movimento(s) no extracto · pagamentos brutos {formatMzn(d.movements.gross)}
              </p>
            </div>
            <div className="rounded-lg border p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Taxas do gateway</p>
              <p className="mt-2 text-xl font-semibold tabular">{formatMzn(d.movements.gatewayFees)}</p>
              <p className="text-xs text-muted-foreground">Debitadas em separado: {formatMzn(d.movements.debitedGateway)}</p>
            </div>
            <div className="rounded-lg border p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Comissão SmartPay</p>
              <p className="mt-2 text-xl font-semibold tabular">{formatMzn(d.movements.platformFees)}</p>
              <p className="text-xs text-muted-foreground">Debitada em separado: {formatMzn(d.movements.debitedPlatform)}</p>
            </div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Deduzido na origem (cenário líquido): {formatMzn(d.movements.deducted)}. Num crédito agregado, um único movimento cobre vários pagamentos; as linhas de detalhe
            não são movimentos bancários.
          </p>
          {d.batchLines.length > 0 && (
            <div className="mt-4 overflow-x-auto rounded-lg border">
              <Table>
                <THead>
                  <tr>
                    <th>Linha</th>
                    <th>Tipo</th>
                    <th>Pagamento</th>
                    <th className="text-right">Bruto</th>
                    <th className="text-right">Taxa gateway</th>
                    <th className="text-right">Comissão SmartPay</th>
                    <th className="text-right">Movimento bancário</th>
                  </tr>
                </THead>
                <TBody>
                  {d.batchLines.map((l) => (
                    <TR key={l.id} className={l.lineKind === "detail" ? "bg-muted/30" : ""}>
                      <td className="font-mono text-xs">
                        {l.lineKind === "detail" ? "↳ " : ""}
                        {l.settlementReference}
                        {l.isDuplicateRow && (
                          <Badge tone="danger" className="ml-2">
                            duplicada
                          </Badge>
                        )}
                      </td>
                      <td className="whitespace-nowrap text-xs">
                        {l.lineKind === "detail"
                          ? "Detalhe do crédito agregado"
                          : l.movementType === "fee_debit"
                            ? l.feeKind === "platform"
                              ? "Débito: comissão SmartPay"
                              : "Débito: taxa do gateway"
                            : l.movementType === "reversal_debit"
                              ? "Débito de reversão"
                              : l.paymentReference
                                ? "Crédito"
                                : "Crédito agregado"}
                      </td>
                      <td className="font-mono text-xs">{l.paymentReference ?? "—"}</td>
                      <td className="whitespace-nowrap text-right text-xs tabular">{formatMzn(l.grossAmountMinor)}</td>
                      <td className="whitespace-nowrap text-right text-xs tabular">{l.gatewayFeeMinor ? formatMzn(l.gatewayFeeMinor) : "—"}</td>
                      <td className="whitespace-nowrap text-right text-xs tabular">{l.platformFeeMinor ? formatMzn(l.platformFeeMinor) : "—"}</td>
                      <td className="whitespace-nowrap text-right text-xs font-medium tabular">{l.lineKind === "detail" ? <span className="text-muted-foreground">(incl. acima)</span> : formatMzn(l.netAmountMinor)}</td>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <div className="flex gap-1 overflow-x-auto border-b px-3 pt-3">
            {TABS.map((t) => {
              const n = t.key === "exceptions" ? exceptionsCount : (d.statusCounts[t.key] ?? 0);
              const active = f.status === t.key;
              return (
                <Link
                  key={t.key}
                  href={link({ status: t.key, page: 1 })}
                  className={cn("-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-3 pb-2.5 text-sm", active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
                >
                  {t.label}
                  <span className={cn("rounded-full px-1.5 text-[11px] tabular", t.key === "exceptions" && n > 0 ? "bg-danger-soft text-danger" : "bg-muted")}>{n}</span>
                </Link>
              );
            })}
          </div>
          {d.records.length === 0 ? (
            <EmptyState
              icon={<Inbox />}
              title={f.status === "exceptions" ? "Sem excepções pendentes" : "Nada para mostrar"}
              description={f.status === "exceptions" ? "Todas as linhas de liquidação importadas estão correspondidas ou resolvidas." : "Ainda não existem registos neste estado."}
            />
          ) : (
            <>
              <Table>
                <THead>
                  <tr>
                    <th>Liquidação</th>
                    <th>Pagamento</th>
                    <th className="text-right">Esperado</th>
                    <th className="text-right">Liquidado</th>
                    <th>Resultado</th>
                    <th>Motivo</th>
                    <th />
                  </tr>
                </THead>
                <TBody>
                  {d.records.map((r) => (
                    <TR key={r.id}>
                      <td>
                        <p className="font-mono text-xs">{r.settlementReference}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {r.batchReference} · {formatDate(r.valueDate)}
                        </p>
                      </td>
                      <td>
                        {r.paymentId ? (
                          <Link href={`/finance/transactions/${r.paymentId}`} className="font-mono text-xs text-primary hover:underline">
                            {r.paymentReference}
                          </Link>
                        ) : (
                          <span className="font-mono text-xs text-muted-foreground">{r.paymentReference ?? (r.movementType === "fee_debit" ? "débito de taxas" : "—")}</span>
                        )}
                      </td>
                      <td className="text-right text-xs tabular">{r.expectedAmountMinor === null ? "—" : formatMzn(r.expectedAmountMinor)}</td>
                      <td className="text-right text-xs tabular">
                        {formatMzn(r.settledAmountMinor)}
                        {r.differenceMinor ? <span className="block text-[11px] text-danger">Δ {formatMzn(r.differenceMinor)}</span> : null}
                      </td>
                      <td>
                        <StatusBadge kind="record" value={r.status} />
                      </td>
                      <td className="max-w-56 text-xs">
                        {REASON_LABELS[r.reasonCode as ReasonCode] ?? r.reasonCode}
                        {r.reviewReason && (
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            “{r.reviewReason}” — {r.reviewer}, {r.reviewedAt ? formatDateTime(r.reviewedAt) : ""}
                          </p>
                        )}
                      </td>
                      <td className="text-right">
                        {["unmatched", "amount_mismatch", "duplicate_settlement", "under_review"].includes(r.status) && (
                          <ReviewDialog recordId={r.id} settlementReference={r.settlementReference} canReconcile={!!r.paymentId && r.reasonCode !== "PAYMENT_ALREADY_SETTLED" && r.reasonCode !== "DUPLICATE_SETTLEMENT_REFERENCE"} />
                        )}
                      </td>
                    </TR>
                  ))}
                </TBody>
              </Table>
              {pages > 1 && (
                <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
                  <span className="text-muted-foreground">
                    Página {f.page} de {pages}
                  </span>
                  <div className="flex gap-2">
                    <Button asChild variant="outline" size="sm" className={f.page <= 1 ? "pointer-events-none opacity-50" : ""}>
                      <Link href={link({ page: f.page - 1 })}>
                        <ChevronLeft /> Anterior
                      </Link>
                    </Button>
                    <Button asChild variant="outline" size="sm" className={f.page >= pages ? "pointer-events-none opacity-50" : ""}>
                      <Link href={link({ page: f.page + 1 })}>
                        Seguinte <ChevronRight />
                      </Link>
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Landmark className="size-4" /> Lotes de liquidação
            </CardTitle>
            <CardDescription>Últimos 12 lotes importados ou simulados</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {d.batches.length === 0 && <p className="text-sm text-muted-foreground">Ainda não há lotes.</p>}
            {d.batches.map(({ batch: b, by }) => (
              <Link key={b.id} href={link({ batch: b.id, status: "exceptions", page: 1 })} className={cn("block rounded-lg border p-3 text-xs transition-colors hover:bg-muted/50", f.batch === b.id && "border-primary")}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono font-medium">{b.batchReference}</span>
                  <StatusBadge kind="feature" value={b.featureStatus} />
                </div>
                <p className="mt-1 text-muted-foreground">
                  {b.source === "file_import" ? `Ficheiro ${b.fileName ?? ""}` : (SCENARIOS[b.scenario as ScenarioKey]?.label ?? b.scenario)} · {formatDateTime(b.createdAt)}
                  {by ? ` · ${by}` : ""}
                </p>
                <p className="mt-1">
                  {b.reconciliationState === "pending" ? (
                    <span className="font-medium text-primary">Por reconciliar · {b.rowCount} linhas</span>
                  ) : (
                    <>
                      <span className="text-success">{b.matchedCount} ok</span> · <span className={b.exceptionCount ? "text-danger" : ""}>{b.exceptionCount} excepções</span> · {b.rowCount} linhas
                    </>
                  )}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{FEE_TREATMENT_LABELS[b.feeTreatment as FeeTreatment] ?? b.feeTreatment}</p>
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
