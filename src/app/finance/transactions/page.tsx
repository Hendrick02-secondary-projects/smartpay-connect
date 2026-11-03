import Link from "next/link";
import { ChevronLeft, ChevronRight, Download, Search, SearchX, X } from "lucide-react";
import { getDb } from "@/lib/db";
import { requireTenantPage } from "@/lib/auth/session";
import { listAccounts, listTransactions, transactionFiltersSchema, type TransactionFilters } from "@/lib/queries/finance";
import { formatMzn } from "@/lib/money";
import { METHOD_LABELS, formatDateTime, maskPhone } from "@/lib/labels";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Input, NativeSelect, TBody, THead, TR, Table } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/status-badge";

export const metadata = { title: "Transacções" };

function qs(f: TransactionFilters, overrides: Partial<Record<keyof TransactionFilters, string | number | undefined>> = {}) {
  const p = new URLSearchParams();
  const merged = { ...f, ...overrides } as Record<string, string | number | undefined>;
  for (const [k, v] of Object.entries(merged)) if (v !== undefined && v !== "" && !(k === "page" && v === 1)) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export default async function TransactionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { organizationId } = await requireTenantPage();
  const raw = await searchParams;
  const flat = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v || undefined]));
  const filters = transactionFiltersSchema.parse(flat);
  const db = getDb();
  const [data, accounts] = await Promise.all([listTransactions(db, organizationId, filters), listAccounts(db, organizationId)]);
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const hasFilters = Object.entries(filters).some(([k, v]) => k !== "page" && v !== undefined);

  return (
    <>
      <PageHeader
        title="Transacções"
        description={`${data.total.toLocaleString("pt-MZ")} resultados · ${formatMzn(data.totalAmountMinor)} (simulado)`}
        actions={
          <Button asChild variant="outline" size="sm">
            <a href={`/api/finance/transactions/export${qs(filters, { page: undefined })}`}>
              <Download /> Exportar Excel
            </a>
          </Button>
        }
      />

      <Card className="mb-4 p-4">
        <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-12">
          <div className="relative lg:col-span-4">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input name="q" defaultValue={filters.q} placeholder="Referência, segurado, telefone ou nota de débito" className="pl-9" aria-label="Pesquisar" />
          </div>
          <div className="lg:col-span-2">
            <NativeSelect name="status" defaultValue={filters.status ?? ""} aria-label="Estado">
              <option value="">Todos os estados</option>
              <option value="successful">Bem-sucedido</option>
              <option value="pending">Pendente</option>
              <option value="created">Criado</option>
              <option value="failed">Falhado</option>
              <option value="cancelled">Cancelado</option>
              <option value="reversed">Revertido</option>
            </NativeSelect>
          </div>
          <div className="lg:col-span-2">
            <NativeSelect name="method" defaultValue={filters.method ?? ""} aria-label="Método">
              <option value="">Todos os métodos</option>
              {Object.entries(METHOD_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="lg:col-span-2">
            <NativeSelect name="account" defaultValue={filters.account ?? ""} aria-label="Conta">
              <option value="">Todas as contas</option>
              {accounts.map((a) => (
                <option key={a.code} value={a.code}>
                  {a.purpose}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="lg:col-span-2">
            <NativeSelect name="recon" defaultValue={filters.recon ?? ""} aria-label="Reconciliação">
              <option value="">Reconciliação: todas</option>
              <option value="unreconciled">Por reconciliar</option>
              <option value="reconciled">Reconciliado</option>
              <option value="exception">Excepção</option>
              <option value="manually_reconciled">Manual</option>
            </NativeSelect>
          </div>
          <div className="lg:col-span-2">
            <NativeSelect name="kit" defaultValue={filters.kit ?? ""} aria-label="Alocação de Pagamentos">
              <option value="">KIT: todas</option>
              <option value="pending">Por alocar</option>
              <option value="partial">Parcialmente alocada</option>
              <option value="complete">Totalmente alocada</option>
              <option value="attention">Com problema</option>
            </NativeSelect>
          </div>
          <div className="lg:col-span-2">
            <NativeSelect name="closure" defaultValue={filters.closure ?? ""} aria-label="Encerramento">
              <option value="">Encerramento: todos</option>
              <option value="open">Em aberto</option>
              <option value="closed">Encerradas</option>
            </NativeSelect>
          </div>
          <div className="flex items-center gap-2 lg:col-span-4">
            <Input type="date" name="from" defaultValue={filters.from} aria-label="De" />
            <span className="text-xs text-muted-foreground">até</span>
            <Input type="date" name="to" defaultValue={filters.to} aria-label="Até" />
          </div>
          <div className="flex gap-2 lg:col-span-4 lg:justify-end">
            {hasFilters && (
              <Button asChild variant="ghost">
                <Link href="/finance/transactions">
                  <X /> Limpar
                </Link>
              </Button>
            )}
            <Button type="submit">Aplicar filtros</Button>
          </div>
        </form>
      </Card>

      <Card>
        {data.rows.length === 0 ? (
          <EmptyState
            icon={<SearchX />}
            title="Nenhuma transacção encontrada"
            description={hasFilters ? "Ajuste ou limpe os filtros para ver mais resultados." : "Ainda não existem pagamentos para esta organização."}
            action={
              hasFilters ? (
                <Button asChild variant="outline">
                  <Link href="/finance/transactions">Limpar filtros</Link>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <Table>
              <THead>
                <tr>
                  <th>Referência</th>
                  <th>Segurado</th>
                  <th>Notas de débito</th>
                  <th>Telefone</th>
                  <th className="text-right">Valor</th>
                  <th>Método</th>
                  <th>Conta de destino</th>
                  <th>Estado</th>
                  <th>Reconciliação</th>
                  <th>KIT</th>
                  <th>Encerramento</th>
                  <th>Criado</th>
                </tr>
              </THead>
              <TBody>
                {data.rows.map((t) => (
                  <TR key={t.id}>
                    <td>
                      <Link href={`/finance/transactions/${t.id}`} className="font-mono text-xs font-medium text-primary hover:underline">
                        {t.reference}
                      </Link>
                    </td>
                    <td className="max-w-44 truncate font-medium">{t.customerName}</td>
                    <td className="max-w-40 truncate font-mono text-xs text-muted-foreground" title={t.debitNotes ?? ""}>
                      {t.debitNotes}
                    </td>
                    <td className="whitespace-nowrap text-xs text-muted-foreground">{maskPhone(t.customerPhone)}</td>
                    <td className="whitespace-nowrap text-right font-medium tabular">{formatMzn(t.amountMinor)}</td>
                    <td className="whitespace-nowrap">{METHOD_LABELS[t.method]}</td>
                    <td className="whitespace-nowrap text-xs">
                      {t.bankName} <span className="text-muted-foreground">{t.accountNumberMasked}</span>
                    </td>
                    <td>
                      <StatusBadge kind="payment" value={t.status} />
                    </td>
                    <td>{t.status === "successful" || t.status === "reversed" ? <StatusBadge kind="recon" value={t.reconciliationStatus} /> : <span className="text-xs text-muted-foreground">—</span>}</td>
                    <td className="whitespace-nowrap text-xs">
                      {t.kitTotal === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <Badge tone={t.kitIssues > 0 ? "danger" : t.kitAllocated === t.kitTotal ? "success" : t.kitAllocated > 0 ? "info" : "warning"}>
                          {t.kitAllocated}/{t.kitTotal} NDs
                        </Badge>
                      )}
                    </td>
                    <td className="whitespace-nowrap text-xs">
                      {t.operationallyClosed ? (
                        <Badge tone="success" dot>
                          Encerrada
                        </Badge>
                      ) : t.status === "successful" || t.status === "reversed" ? (
                        <span className="text-muted-foreground">Em aberto</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(t.createdAt)}</td>
                  </TR>
                ))}
              </TBody>
            </Table>
            <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
              <span className="text-muted-foreground">
                Página {data.page} de {pages}
              </span>
              <div className="flex gap-2">
                <Button asChild variant="outline" size="sm" aria-disabled={data.page <= 1} className={data.page <= 1 ? "pointer-events-none opacity-50" : ""}>
                  <Link href={`/finance/transactions${qs(filters, { page: Math.max(1, data.page - 1) })}`}>
                    <ChevronLeft /> Anterior
                  </Link>
                </Button>
                <Button asChild variant="outline" size="sm" aria-disabled={data.page >= pages} className={data.page >= pages ? "pointer-events-none opacity-50" : ""}>
                  <Link href={`/finance/transactions${qs(filters, { page: Math.min(pages, data.page + 1) })}`}>
                    Seguinte <ChevronRight />
                  </Link>
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>
    </>
  );
}
