import { FlaskConical, Undo2 } from "lucide-react";
import { getDb } from "@/lib/db";
import { requireOwnerPage } from "@/lib/auth/session";
import { listReversiblePayments, listSettlementBatchesAllTenants } from "@/lib/queries/owner";
import { formatMzn } from "@/lib/money";
import { formatDateTime } from "@/lib/labels";
import { FEATURE_STATUS_LABELS, SCENARIOS, SIMULATED_GATEWAY_FEE_PPM, type ScenarioKey } from "@/lib/settlement/scenarios";
import { ppmToPercentString } from "@/lib/money";
import { PageHeader } from "@/components/layout/app-shell";
import { ActionForm } from "@/components/dashboard/action-form";
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, NativeSelect, TBody, THead, TR, Table } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/status-badge";
import { reversePaymentAction } from "../actions";

export const metadata = { title: "Liquidações e taxas" };

/** Banking capabilities and their verification status — everything is "Simulated" in V1. */
const CAPABILITIES = [
  { feature: "Seguradora recebe o valor bruto", status: "simulated" },
  { feature: "Comissão SmartPay retida na origem pelo gateway", status: "simulated" },
  { feature: "Taxas do gateway debitadas separadamente", status: "simulated" },
  { feature: "Liquidação agregada diária", status: "simulated" },
  { feature: "Ficheiro de liquidação normalizado do banco/gateway", status: "not_verified" },
  { feature: "Webhooks assinados do fornecedor real", status: "not_verified" },
  { feature: "Reversões / chargebacks reportados pelo fornecedor", status: "not_verified" },
] as const;

export default async function SettlementsPage() {
  await requireOwnerPage();
  const db = getDb();
  const [batches, reversible] = await Promise.all([listSettlementBatchesAllTenants(db), listReversiblePayments(db)]);

  return (
    <>
      <PageHeader title="Liquidações e taxas" description="Modelo de liquidação simulado · registos separados de pagamento, taxa do gateway, comissão e movimento" />
      <Alert tone="danger" className="mb-4">
        A MVP <strong>não afirma</strong> que qualquer fornecedor real suporta este comportamento bancário. Todos os eventos de liquidação nesta versão são explicitamente
        simulados.
      </Alert>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Estado de verificação das capacidades bancárias</CardTitle>
            <CardDescription>
              Escala: {Object.values(FEATURE_STATUS_LABELS).join(" → ")}
            </CardDescription>
          </CardHeader>
          <Table>
            <THead>
              <tr>
                <th>Capacidade</th>
                <th>Estado</th>
              </tr>
            </THead>
            <TBody>
              {CAPABILITIES.map((c) => (
                <TR key={c.feature}>
                  <td>{c.feature}</td>
                  <td>
                    <StatusBadge kind="feature" value={c.status} />
                  </td>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Taxas fictícias do gateway simulado</CardTitle>
            <CardDescription>Usadas apenas para demonstrar registos separados</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {Object.entries(SIMULATED_GATEWAY_FEE_PPM).map(([m, ppm]) => (
              <div key={m} className="flex justify-between">
                <span className="text-muted-foreground">{m === "card" ? "Visa / Mastercard" : m === "mpesa" ? "M-Pesa" : "e-Mola"}</span>
                <span className="font-medium tabular">{ppmToPercentString(ppm)}%</span>
              </div>
            ))}
            <Badge tone="warning" className="mt-2">
              Valores fictícios
            </Badge>
          </CardContent>
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Lotes de liquidação (todas as organizações)</CardTitle>
          </CardHeader>
          <Table>
            <THead>
              <tr>
                <th>Lote</th>
                <th>Organização</th>
                <th>Cenário</th>
                <th className="text-right">Bruto</th>
                <th>Resultado</th>
                <th>Estado</th>
              </tr>
            </THead>
            <TBody>
              {batches.map(({ batch: b, organization }) => (
                <TR key={b.id}>
                  <td>
                    <p className="font-mono text-xs">{b.batchReference}</p>
                    <p className="text-[11px] text-muted-foreground">{formatDateTime(b.createdAt)}</p>
                  </td>
                  <td className="text-xs">{organization}</td>
                  <td className="text-xs">{b.scenario === "file" ? `Ficheiro${b.fileName ? ` ${b.fileName}` : ""}` : SCENARIOS[b.scenario as ScenarioKey]?.label}</td>
                  <td className="text-right text-xs tabular">{formatMzn(b.totalGrossMinor)}</td>
                  <td className="text-xs">
                    {b.matchedCount}/{b.rowCount} ok{b.exceptionCount ? <span className="text-danger"> · {b.exceptionCount} exc.</span> : null}
                  </td>
                  <td>
                    <StatusBadge kind="feature" value={b.featureStatus} />
                  </td>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>

        <Card className="h-fit border-dashed">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FlaskConical className="size-4" /> Simular reversão
            </CardTitle>
            <CardDescription>Pede ao fornecedor simulado que reverta um pagamento; gera um webhook assinado e uma reversão compensatória da comissão.</CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={reversePaymentAction} submitLabel="Reverter pagamento" variant="destructive" confirm="Reverter este pagamento simulado?">
              <NativeSelect name="paymentId" aria-label="Pagamento">
                {reversible.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.reference} · {formatMzn(p.amountMinor)}
                  </option>
                ))}
              </NativeSelect>
              <div className="space-y-1.5">
                <Label htmlFor="rev-reason">Motivo</Label>
                <Input id="rev-reason" name="reason" placeholder="Chargeback simulado — disputa do titular" required minLength={10} />
              </div>
              <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Undo2 className="size-3" /> Operação registada no log de auditoria.
              </p>
            </ActionForm>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
