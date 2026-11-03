import { ReceiptText, Wallet } from "lucide-react";
import { getDb } from "@/lib/db";
import { requireOwnerPage } from "@/lib/auth/session";
import { listInvoices, listOrganizations } from "@/lib/queries/owner";
import { formatMzn } from "@/lib/money";
import { formatDate, formatDateTime } from "@/lib/labels";
import { PageHeader } from "@/components/layout/app-shell";
import { ActionForm } from "@/components/dashboard/action-form";
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Input, Label, NativeSelect, TBody, THead, TR, Table } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/status-badge";
import { issueInvoiceAction, recordCollectionAction } from "../actions";

export const metadata = { title: "Facturas e cobranças" };

export default async function InvoicesPage() {
  await requireOwnerPage();
  const db = getDb();
  const [data, orgs] = await Promise.all([listInvoices(db), listOrganizations(db)]);
  const open = data.invoices.filter((i) => i.invoice.status === "issued" || i.invoice.status === "partially_paid");
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 8)}01`;

  return (
    <>
      <PageHeader title="Facturas e cobranças" description="Facturação e cobrança simuladas ou registadas manualmente (V1)" />
      <Alert tone="warning" className="mb-4">
        Nesta versão, facturas e cobranças são <strong>simuladas / registadas manualmente</strong>. Uma comissão só é considerada recebida quando existe um registo de
        cobrança — nunca apenas porque o pagamento foi bem-sucedido. Partilha automática de receita pelo gateway exigirá configuração contratual e eventos de liquidação
        verificados do fornecedor.
      </Alert>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Facturas de comissão</CardTitle>
              <CardDescription>
                Por facturar: {formatMzn(data.uninvoiced.amountMinor)} ({data.uninvoiced.count} entradas do ledger)
              </CardDescription>
            </CardHeader>
            {data.invoices.length === 0 ? (
              <EmptyState icon={<ReceiptText />} title="Sem facturas" description="Emita uma factura simulada para agrupar as comissões acumuladas de um período." />
            ) : (
              <Table>
                <THead>
                  <tr>
                    <th>Factura</th>
                    <th>Período</th>
                    <th className="text-right">Valor</th>
                    <th className="text-right">Cobrado</th>
                    <th className="text-right">Em dívida</th>
                    <th>Estado</th>
                  </tr>
                </THead>
                <TBody>
                  {data.invoices.map((i) => (
                    <TR key={i.invoice.id}>
                      <td>
                        <p className="font-mono text-xs font-medium">{i.invoice.invoiceNumber}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {i.organization} · {i.lines} linhas
                        </p>
                      </td>
                      <td className="whitespace-nowrap text-xs">
                        {formatDate(i.invoice.periodStart)} – {formatDate(i.invoice.periodEnd)}
                      </td>
                      <td className="text-right tabular">{formatMzn(i.invoice.amountMinor)}</td>
                      <td className="text-right tabular text-success">{formatMzn(i.collected)}</td>
                      <td className="text-right font-medium tabular">{formatMzn(i.invoice.amountMinor - i.collected)}</td>
                      <td>
                        <StatusBadge kind="commission" value={i.invoice.status} />
                      </td>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Wallet className="size-4" /> Cobranças registadas
              </CardTitle>
            </CardHeader>
            {data.payouts.length === 0 ? (
              <CardContent>
                <p className="text-sm text-muted-foreground">Nenhuma cobrança registada.</p>
              </CardContent>
            ) : (
              <Table>
                <THead>
                  <tr>
                    <th>Data</th>
                    <th>Factura</th>
                    <th>Referência</th>
                    <th className="text-right">Valor</th>
                    <th>Registado por</th>
                  </tr>
                </THead>
                <TBody>
                  {data.payouts.map((p) => (
                    <TR key={p.payout.id}>
                      <td className="text-xs">{formatDateTime(p.payout.receivedAt)}</td>
                      <td className="font-mono text-xs">{p.invoiceNumber}</td>
                      <td className="font-mono text-xs">
                        {p.payout.collectionReference} <Badge tone="warning">Simulado</Badge>
                      </td>
                      <td className="text-right font-medium tabular">{formatMzn(p.payout.amountMinor)}</td>
                      <td className="text-xs text-muted-foreground">{p.recordedBy ?? "sistema (seed)"}</td>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Emitir factura simulada</CardTitle>
              <CardDescription>Agrupa todas as entradas do ledger ainda não facturadas no período.</CardDescription>
            </CardHeader>
            <CardContent>
              <ActionForm action={issueInvoiceAction} submitLabel="Emitir factura">
                <NativeSelect name="organizationId" aria-label="Organização">
                  {orgs.map((o) => (
                    <option key={o.org.id} value={o.org.id}>
                      {o.org.name}
                    </option>
                  ))}
                </NativeSelect>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="i-from">De</Label>
                    <Input id="i-from" type="date" name="periodStart" defaultValue={monthStart} required />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="i-to">Até</Label>
                    <Input id="i-to" type="date" name="periodEnd" defaultValue={today} required />
                  </div>
                </div>
              </ActionForm>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Registar cobrança</CardTitle>
              <CardDescription>Regista o recebimento (simulado/manual) contra uma factura em aberto.</CardDescription>
            </CardHeader>
            <CardContent>
              {open.length === 0 ? (
                <p className="text-sm text-muted-foreground">Não há facturas em aberto.</p>
              ) : (
                <ActionForm action={recordCollectionAction} submitLabel="Registar cobrança">
                  <NativeSelect name="invoiceId" aria-label="Factura">
                    {open.map((i) => (
                      <option key={i.invoice.id} value={i.invoice.id}>
                        {i.invoice.invoiceNumber} — em dívida {formatMzn(i.invoice.amountMinor - i.collected)}
                      </option>
                    ))}
                  </NativeSelect>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="c-amt">Valor (MZN)</Label>
                      <Input id="c-amt" name="amount" inputMode="decimal" required />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="c-date">Data</Label>
                      <Input id="c-date" type="date" name="receivedAt" defaultValue={today} required />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="c-ref">Referência da cobrança</Label>
                    <Input id="c-ref" name="collectionReference" placeholder="DEMO-TRF-0001" required />
                  </div>
                  <NativeSelect name="method" aria-label="Meio">
                    <option value="bank_transfer">Transferência bancária (simulada)</option>
                    <option value="netting">Compensação (simulada)</option>
                    <option value="other">Outro</option>
                  </NativeSelect>
                </ActionForm>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
