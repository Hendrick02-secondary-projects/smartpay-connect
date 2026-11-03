import Link from "next/link";
import { ChevronLeft, ChevronRight, FileCheck2, Inbox } from "lucide-react";
import { getDb } from "@/lib/db";
import { requireTenantPage } from "@/lib/auth/session";
import { allocationQueueSchema, listAllocationQueue, PAGE_SIZE } from "@/lib/queries/finance";
import { KIT_STATUS_LABELS, type KitStatus } from "@/lib/kit/allocation";
import { maputoDate } from "@/lib/kit/service";
import { formatMzn } from "@/lib/money";
import { formatDate, formatDateTime } from "@/lib/labels";
import { PageHeader } from "@/components/layout/app-shell";
import { AutoRefresh } from "@/components/layout/auto-refresh";
import { AllocationDialog } from "@/components/dashboard/allocation-dialog";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card, EmptyState, TBody, THead, TR, Table } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

export const metadata = { title: "Alocação de Pagamentos" };

const TABS = [
  { key: "to_allocate", label: "Por alocar" },
  { key: "issues", label: "Com problema" },
  { key: "to_void", label: "Anular (revertidos)" },
  { key: "ready_to_close", label: "Prontas a encerrar" },
  { key: "allocated", label: "Alocadas" },
] as const;

const TONE: Record<KitStatus, "warning" | "success" | "danger" | "neutral"> = { pending: "warning", allocated: "success", issue: "danger", voided: "neutral" };

export default async function AllocationsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { organizationId } = await requireTenantPage("tenant:kit:allocate");
  const f = allocationQueueSchema.parse(await searchParams);
  const data = await listAllocationQueue(getDb(), organizationId, f);
  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const today = maputoDate(new Date());
  const href = (o: { view?: string; page?: number }) => {
    const p = new URLSearchParams({ view: o.view ?? f.view });
    if ((o.page ?? 1) > 1) p.set("page", String(o.page));
    return `/finance/allocations?${p.toString()}`;
  };
  // "ready_to_close" lists one row per debit note; show each transaction once.
  const rows = f.view === "ready_to_close" ? data.rows.filter((r, i, all) => all.findIndex((x) => x.paymentId === r.paymentId) === i) : data.rows;

  return (
    <>
      <PageHeader
        title="Alocação de Pagamentos"
        description="Registo manual da alocação de cada nota de débito no sistema KIT da seguradora"
        actions={<AutoRefresh />}
      />
      <Alert tone="info" className="mb-4">
        Nesta versão o KIT <strong>não está integrado</strong>: a equipa Finance aloca no KIT e regista aqui o nº do recibo, a data e as observações. Só é possível alocar
        depois de o pagamento estar reconciliado com o banco. Uma transacção só fica totalmente alocada quando todas as suas notas de débito estiverem alocadas.
      </Alert>

      <Card>
        <div className="flex gap-1 overflow-x-auto border-b px-3 pt-3">
          {TABS.map((t) => {
            const n = data.counts[t.key];
            const active = f.view === t.key;
            return (
              <Link
                key={t.key}
                href={href({ view: t.key })}
                className={cn("-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-3 pb-2.5 text-sm", active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
              >
                {t.label}
                <span className={cn("rounded-full px-1.5 text-[11px] tabular", (t.key === "issues" || t.key === "to_void") && n > 0 ? "bg-danger-soft text-danger" : "bg-muted")}>{n}</span>
              </Link>
            );
          })}
        </div>

        {rows.length === 0 ? (
          <EmptyState
            icon={f.view === "to_allocate" ? <FileCheck2 /> : <Inbox />}
            title={f.view === "to_allocate" ? "Nada por alocar" : "Sem registos"}
            description={
              f.view === "to_allocate"
                ? "As notas de débito aparecem aqui assim que o pagamento é reconciliado com o banco."
                : "Não existem notas de débito neste estado."
            }
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <th>Transacção</th>
                <th>Segurado</th>
                {f.view !== "ready_to_close" && <th>Nota de débito</th>}
                {f.view !== "ready_to_close" && <th className="text-right">Valor</th>}
                {f.view !== "ready_to_close" && <th>Estado</th>}
                {f.view !== "ready_to_close" && <th>Recibo KIT / observações</th>}
                <th>Data</th>
                <th />
              </tr>
            </THead>
            <TBody>
              {rows.map((r) => (
                <TR key={r.id}>
                  <td>
                    <Link href={`/finance/transactions/${r.paymentId}`} className="font-mono text-xs font-medium text-primary hover:underline">
                      {r.reference}
                    </Link>
                  </td>
                  <td className="max-w-44 truncate">{r.customerName}</td>
                  {f.view !== "ready_to_close" && <td className="font-mono text-xs">{r.debitNoteNumber}</td>}
                  {f.view !== "ready_to_close" && <td className="whitespace-nowrap text-right tabular">{formatMzn(r.amountMinor)}</td>}
                  {f.view !== "ready_to_close" && (
                    <td>
                      <Badge tone={TONE[r.status]} dot>
                        {KIT_STATUS_LABELS[r.status]}
                      </Badge>
                    </td>
                  )}
                  {f.view !== "ready_to_close" && (
                    <td className="max-w-56 text-xs">
                      {r.receiptReference && <span className="font-mono">{r.receiptReference}</span>}
                      {r.notes && <p className="truncate text-muted-foreground" title={r.notes}>{r.notes}</p>}
                    </td>
                  )}
                  <td className="whitespace-nowrap text-xs text-muted-foreground">{r.allocatedOn ? formatDate(r.allocatedOn) : formatDateTime(r.paymentCreatedAt)}</td>
                  <td className="text-right">
                    {f.view === "ready_to_close" ? (
                      <Button asChild size="sm">
                        <Link href={`/finance/transactions/${r.paymentId}#encerramento`}>Encerrar</Link>
                      </Button>
                    ) : (
                      <AllocationDialog
                        row={{ id: r.id, status: r.status, version: r.version, debitNoteNumber: r.debitNoteNumber, amountMinor: r.amountMinor, receiptReference: r.receiptReference }}
                        paymentReversed={r.paymentStatus === "reversed"}
                        locked={r.operationallyClosed}
                        today={today}
                      />
                    )}
                  </td>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        {pages > 1 && (
          <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
            <span className="text-muted-foreground">
              Página {f.page} de {pages}
            </span>
            <div className="flex gap-2">
              <Button asChild variant="outline" size="sm" className={f.page <= 1 ? "pointer-events-none opacity-50" : ""}>
                <Link href={href({ page: f.page - 1 })}>
                  <ChevronLeft /> Anterior
                </Link>
              </Button>
              <Button asChild variant="outline" size="sm" className={f.page >= pages ? "pointer-events-none opacity-50" : ""}>
                <Link href={href({ page: f.page + 1 })}>
                  Seguinte <ChevronRight />
                </Link>
              </Button>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}
