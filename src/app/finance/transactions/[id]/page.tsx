import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CheckCircle2, CircleDashed, FileCheck2, Info, ShieldCheck, ShieldX } from "lucide-react";
import { getDb } from "@/lib/db";
import { requireTenantPage } from "@/lib/auth/session";
import { getTransactionDetail } from "@/lib/queries/finance";
import { KIT_STATUS_LABELS, type KitStatus } from "@/lib/kit/allocation";
import { maputoDate } from "@/lib/kit/service";
import { INSURER_STAGES } from "@/lib/lifecycle/stages";
import { formatMzn } from "@/lib/money";
import { METHOD_LABELS, formatDate, formatDateTime, formatPhone } from "@/lib/labels";
import { REASON_LABELS, type ReasonCode } from "@/lib/reconciliation/matcher";
import { AutoRefresh } from "@/components/layout/auto-refresh";
import { AllocationDialog } from "@/components/dashboard/allocation-dialog";
import { ClosurePanel } from "@/components/dashboard/closure-panel";
import { StageTracker } from "@/components/lifecycle/stage-tracker";
import { Timeline } from "@/components/lifecycle/timeline";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, TBody, THead, TR, Table } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/status-badge";

export const metadata = { title: "Detalhe da transacção" };

const KIT_TONE = { pending: "warning", allocated: "success", issue: "danger", voided: "neutral" } as const;

export default async function TransactionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { organizationId } = await requireTenantPage();
  const { id } = await params;
  // Tenant-scoped lookup: another organisation's id returns 404.
  const d = await getTransactionDetail(getDb(), organizationId, id);
  if (!d) notFound();
  const { intent, account, lifecycle } = d;
  const charge = d.transactions.find((t) => t.type === "charge");
  const operational = lifecycle.stages.filter((s) => INSURER_STAGES.includes(s.key));
  const closed = !!lifecycle.facts.operationalClosure;
  const reversed = intent.status === "reversed";
  const allocSummary = lifecycle.facts.allocations;
  const today = maputoDate(new Date());
  // One row per debit note; payments that never succeeded have no allocation rows.
  type NdRow = { id: string; debitNoteNumber: string; amountMinor: number; status: KitStatus | null; receiptReference: string | null; allocatedOn: string | null; notes: string | null; version: number };
  const ndRows: NdRow[] = d.allocations.length
    ? d.allocations.map((a) => ({ ...a }))
    : d.notes.map((n) => ({ id: n.id, debitNoteNumber: n.debitNoteNumber, amountMinor: n.amountMinor, status: null, receiptReference: null, allocatedOn: null, notes: null, version: 0 }));

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/finance/transactions">
            <ArrowLeft /> Transacções
          </Link>
        </Button>
        <AutoRefresh />
      </div>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-mono text-sm text-muted-foreground">{intent.reference}</p>
          <h1 className="text-2xl font-semibold tracking-tight tabular">{formatMzn(intent.amountMinor)}</h1>
          <p className="text-sm text-muted-foreground">{intent.customerName}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusBadge kind="payment" value={intent.status} />
          {(intent.status === "successful" || reversed) && <StatusBadge kind="recon" value={intent.reconciliationStatus} />}
          {closed && (
            <Badge tone="success" dot>
              Encerrada (seguradora)
            </Badge>
          )}
          <Badge tone="warning">Simulado</Badge>
        </div>
      </div>

      <Card className="mb-4">
        <CardContent className="p-5">
          <StageTracker stages={operational} layout="horizontal" title="Ciclo operacional da seguradora" />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileCheck2 className="size-4" /> Notas de débito e alocação no KIT
              </CardTitle>
              <CardDescription>
                {allocSummary.total === 0
                  ? "Introduzidas pelo cliente — não verificadas no sistema da seguradora (V1)."
                  : `${allocSummary.allocated} de ${allocSummary.total} alocadas. Cada nota tem estado próprio; a transacção só fica totalmente alocada quando todas estiverem alocadas.`}
              </CardDescription>
            </CardHeader>
            {reversed && allocSummary.allocated > 0 && (
              <CardContent className="pb-3">
                <Alert tone="warning">Pagamento revertido: anule no KIT as notas que já tinham sido alocadas e registe aqui a anulação.</Alert>
              </CardContent>
            )}
            {intent.status === "successful" && intent.reconciliationStatus !== "reconciled" && intent.reconciliationStatus !== "manually_reconciled" && d.allocations.length > 0 && (
              <CardContent className="pb-3">
                <Alert tone="info">A alocação fica disponível depois de o pagamento ser reconciliado com o banco.</Alert>
              </CardContent>
            )}
            <Table>
              <THead>
                <tr>
                  <th>Nota de débito</th>
                  <th className="text-right">Valor</th>
                  <th>Estado KIT</th>
                  <th>Recibo · data</th>
                  <th />
                </tr>
              </THead>
              <TBody>
                {ndRows.map((a) => (
                  <TR key={a.id}>
                    <td className="font-mono text-xs">{a.debitNoteNumber}</td>
                    <td className="whitespace-nowrap text-right tabular">{formatMzn(a.amountMinor)}</td>
                    <td>
                      {a.status ? (
                        <Badge tone={KIT_TONE[a.status]} dot>
                          {KIT_STATUS_LABELS[a.status]}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="max-w-56 text-xs">
                      {a.receiptReference && <span className="font-mono">{a.receiptReference}</span>}
                      {a.allocatedOn && <span className="text-muted-foreground"> · {formatDate(a.allocatedOn)}</span>}
                      {a.notes && <p className="truncate text-muted-foreground" title={a.notes}>{a.notes}</p>}
                    </td>
                    <td className="text-right">
                      {a.status && (
                        <AllocationDialog
                          row={{ id: a.id, status: a.status, version: a.version, debitNoteNumber: a.debitNoteNumber, amountMinor: a.amountMinor, receiptReference: a.receiptReference }}
                          paymentReversed={reversed}
                          locked={closed || (intent.status === "successful" && intent.reconciliationStatus !== "reconciled" && intent.reconciliationStatus !== "manually_reconciled" && a.status === "pending")}
                          today={today}
                        />
                      )}
                    </td>
                  </TR>
                ))}
                <TR className="bg-muted/40 font-semibold">
                  <td>Total</td>
                  <td className="text-right tabular">{formatMzn(intent.amountMinor)}</td>
                  <td colSpan={3} />
                </TR>
              </TBody>
            </Table>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Reconciliação bancária</CardTitle>
              <CardDescription>A confirmação do pagamento e a reconciliação com o banco são etapas distintas.</CardDescription>
            </CardHeader>
            <CardContent>
              {d.recon.length === 0 ? (
                <Alert tone={intent.status === "successful" ? "warning" : "info"} icon={<Info />}>
                  {intent.status === "successful"
                    ? lifecycle.facts.settlement.lines > 0
                      ? "Liquidação recebida — aguarda reconciliação pela equipa Finance (página Reconciliação)."
                      : "Pagamento confirmado pelo fornecedor, mas ainda sem linha de liquidação correspondente. Não está reconciliado."
                    : "Sem movimentos de liquidação para este pagamento."}
                </Alert>
              ) : (
                <ul className="space-y-2">
                  {d.recon.map((r) => (
                    <li key={r.record.id} className="rounded-lg border p-3 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-mono text-xs">{r.settlement.settlementReference}</span>
                        <StatusBadge kind="record" value={r.record.status} />
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Lote {r.batchRef} · {r.settlement.lineKind === "detail" ? "linha de um crédito agregado · " : ""}
                        {REASON_LABELS[r.record.reasonCode as ReasonCode] ?? r.record.reasonCode} · liquidado {formatMzn(r.record.settledAmountMinor)}
                      </p>
                      {r.record.reviewReason && <p className="mt-2 rounded bg-muted px-2 py-1 text-xs">Revisão: {r.record.reviewReason}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Linha temporal</CardTitle>
              <CardDescription>Eventos operacionais registados na base de dados (pagamento, liquidação, reconciliação, KIT, encerramento)</CardDescription>
            </CardHeader>
            <CardContent>
              <Timeline events={d.timeline} />
            </CardContent>
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          <Card id="encerramento" className="scroll-mt-24">
            <CardHeader>
              <CardTitle>Encerramento operacional</CardTitle>
              <CardDescription>Conclui o processo da seguradora. Não depende do recebimento da comissão SmartPay.</CardDescription>
            </CardHeader>
            <CardContent>
              {intent.status === "successful" || reversed ? (
                <ClosurePanel
                  closed={closed}
                  canClose={lifecycle.canCloseOperational.ok}
                  reasons={lifecycle.canCloseOperational.reasons}
                  endpoint={`/api/finance/transactions/${intent.id}/closure`}
                  closeLabel="Encerrar processo operacional"
                  closedLabel={`Encerrada em ${lifecycle.facts.operationalClosure ? formatDateTime(lifecycle.facts.operationalClosure.closedAt) : ""}`}
                />
              ) : (
                <p className="text-sm text-muted-foreground">Só pagamentos confirmados podem ser encerrados.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Dados do pagamento</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Info2 label="Telemóvel" value={formatPhone(intent.customerPhone)} />
              <Info2 label="Método" value={`${METHOD_LABELS[intent.paymentMethod]} (simulado)`} />
              <Info2 label="Conta de destino" value={`${account.bankName} · ${account.accountNumberMasked}`} sub={account.accountName} />
              <Info2 label="Criado em" value={formatDateTime(intent.createdAt)} />
              <Info2 label="Concluído em" value={intent.completedAt ? formatDateTime(intent.completedAt) : "—"} />
              <Info2 label="Referência do fornecedor" value={intent.providerReference ?? "—"} mono />
              {intent.failureReason && <Info2 label="Motivo" value={intent.failureReason} mono />}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Movimentos registados</CardTitle>
              <CardDescription>Registos separados por natureza</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Pagamento do cliente" value={charge ? formatMzn(charge.amountMinor) : "—"} />
              <Row label="Taxa do gateway (simulada)" value={charge ? formatMzn(charge.gatewayFeeMinor) : "—"} />
              {d.transactions.some((t) => t.type === "reversal") && <Row label="Reversão" value={formatMzn(-intent.amountMinor)} />}
              <p className="pt-2 text-[11px] text-muted-foreground">A comissão da plataforma é registada no ledger SmartPay e não altera o valor devido à seguradora.</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Eventos do fornecedor</CardTitle>
              <CardDescription>Webhooks verificados e deduplicados</CardDescription>
            </CardHeader>
            <CardContent>
              <ol className="relative space-y-4 border-l pl-4">
                {d.events.map((e, i) => (
                  <li key={i} className="text-xs">
                    <span className="absolute -left-[7px] mt-0.5 flex size-3.5 items-center justify-center rounded-full bg-card">
                      {e.processingStatus === "processed" ? <CheckCircle2 className="size-3.5 text-success" /> : <CircleDashed className="size-3.5 text-muted-foreground" />}
                    </span>
                    <p className="font-medium">{e.eventType}</p>
                    <p className="text-muted-foreground">
                      {e.fromStatus ?? "∅"} → {e.toStatus ?? "∅"} · {e.processingStatus}
                      {e.processingNote ? ` (${e.processingNote})` : ""}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1 text-muted-foreground">
                      {e.signatureValid ? <ShieldCheck className="size-3 text-success" /> : <ShieldX className="size-3 text-danger" />}
                      {formatDateTime(e.receivedAt)}
                    </p>
                  </li>
                ))}
                {d.events.length === 0 && <li className="text-xs text-muted-foreground">Sem eventos.</li>}
              </ol>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

function Info2({ label, value, sub, mono }: { label: string; value: string; sub?: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={mono ? "break-all font-mono text-xs" : "font-medium"}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular">{value}</span>
    </div>
  );
}
