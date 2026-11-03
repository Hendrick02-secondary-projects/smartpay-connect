import Link from "next/link";
import { BookOpenCheck, ChevronLeft, ChevronRight, Download, Lock } from "lucide-react";
import { getDb } from "@/lib/db";
import { requireOwnerPage } from "@/lib/auth/session";
import { LEDGER_PAGE_SIZE, listLedger, listOrganizations } from "@/lib/queries/owner";
import { formatMzn, ppmToPercentString } from "@/lib/money";
import { formatDateTime } from "@/lib/labels";
import { PageHeader } from "@/components/layout/app-shell";
import { ActionForm } from "@/components/dashboard/action-form";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Input, Label, NativeSelect, TBody, THead, TR, Table, Textarea } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/status-badge";
import { createAdjustmentAction } from "../actions";

export const metadata = { title: "Ledger de comissões" };

const TYPE_LABEL = { accrual: "Acumulação", adjustment: "Ajuste", reversal: "Reversão" } as const;

export default async function CommissionsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  await requireOwnerPage();
  const page = Math.max(1, Math.min(10_000, Number((await searchParams).page) || 1));
  const db = getDb();
  const [ledger, orgs] = await Promise.all([listLedger(db, page), listOrganizations(db)]);
  const pages = Math.max(1, Math.ceil(ledger.total / LEDGER_PAGE_SIZE));

  return (
    <>
      <PageHeader
        title="Ledger de comissões"
        description={`${ledger.total.toLocaleString("pt-MZ")} entradas · imutável (só inserções)`}
        actions={
          <Button asChild variant="outline" size="sm">
            <a href="/api/owner/commissions/export">
              <Download /> Exportar Excel
            </a>
          </Button>
        }
      />
      <Alert tone="info" icon={<Lock />} className="mb-4">
        As entradas do ledger nunca são alteradas nem apagadas (garantido por trigger na base de dados). Correcções são feitas com entradas compensatórias.
      </Alert>

      <div className="grid gap-4 xl:grid-cols-4">
        <Card className="xl:col-span-3">
          {ledger.rows.length === 0 ? (
            <EmptyState icon={<BookOpenCheck />} title="Ledger vazio" description="As comissões aparecem aqui quando um pagamento fica elegível (bem-sucedido)." />
          ) : (
            <>
              <Table>
                <THead>
                  <tr>
                    <th>Data</th>
                    <th>Tipo</th>
                    <th>Pagamento</th>
                    <th>Regra</th>
                    <th className="text-right">Base</th>
                    <th className="text-right">Comissão</th>
                    <th>Ciclo de vida</th>
                    <th>Factura</th>
                  </tr>
                </THead>
                <TBody>
                  {ledger.rows.map((r) => (
                    <TR key={r.entry.id}>
                      <td className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(r.entry.createdAt)}</td>
                      <td>
                        <Badge tone={r.entry.entryType === "accrual" ? "info" : r.entry.entryType === "reversal" ? "danger" : "warning"}>{TYPE_LABEL[r.entry.entryType]}</Badge>
                      </td>
                      <td className="font-mono text-xs">
                        {r.paymentReference ?? <span className="font-sans text-muted-foreground">{r.entry.reason?.slice(0, 40)}</span>}
                        <span className="block font-sans text-[11px] text-muted-foreground">{r.organization}</span>
                      </td>
                      <td className="whitespace-nowrap text-xs">{r.entry.ruleVersion ? `v${r.entry.ruleVersion} · ${ppmToPercentString(r.entry.ratePpm ?? 0)}%` : "—"}</td>
                      <td className="whitespace-nowrap text-right text-xs tabular">{r.entry.baseAmountMinor === null ? "—" : formatMzn(r.entry.baseAmountMinor)}</td>
                      <td className={`whitespace-nowrap text-right font-medium tabular ${r.entry.amountMinor < 0 ? "text-danger" : ""}`}>{formatMzn(r.entry.amountMinor)}</td>
                      <td>
                        <StatusBadge kind="commission" value={r.lifecycle} />
                      </td>
                      <td className="whitespace-nowrap font-mono text-[11px]">{r.invoiceNumber ?? "—"}</td>
                    </TR>
                  ))}
                </TBody>
              </Table>
              <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
                <span className="text-muted-foreground">
                  Página {page} de {pages}
                </span>
                <div className="flex gap-2">
                  <Button asChild variant="outline" size="sm" className={page <= 1 ? "pointer-events-none opacity-50" : ""}>
                    <Link href={`/owner/commissions?page=${page - 1}`}>
                      <ChevronLeft /> Anterior
                    </Link>
                  </Button>
                  <Button asChild variant="outline" size="sm" className={page >= pages ? "pointer-events-none opacity-50" : ""}>
                    <Link href={`/owner/commissions?page=${page + 1}`}>
                      Seguinte <ChevronRight />
                    </Link>
                  </Button>
                </div>
              </div>
            </>
          )}
        </Card>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Ajuste manual</CardTitle>
            <CardDescription>Cria uma nova entrada de ajuste (nunca edita entradas existentes).</CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={createAdjustmentAction} submitLabel="Registar ajuste">
              <div className="space-y-1.5">
                <Label htmlFor="adj-org">Organização</Label>
                <NativeSelect id="adj-org" name="organizationId" required>
                  {orgs.map((o) => (
                    <option key={o.org.id} value={o.org.id}>
                      {o.org.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="adj-dir">Sentido</Label>
                  <NativeSelect id="adj-dir" name="direction">
                    <option value="debit">Débito (−)</option>
                    <option value="credit">Crédito (+)</option>
                  </NativeSelect>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="adj-amt">Valor (MZN)</Label>
                  <Input id="adj-amt" name="amount" inputMode="decimal" placeholder="10,00" required />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="adj-reason">Motivo</Label>
                <Textarea id="adj-reason" name="reason" required minLength={10} placeholder="Ex.: Crédito acordado por atraso de liquidação em Out/2026." />
              </div>
            </ActionForm>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
