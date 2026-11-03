import { History, Percent } from "lucide-react";
import { getDb } from "@/lib/db";
import { requireOwnerPage } from "@/lib/auth/session";
import { listOrganizations, listRules } from "@/lib/queries/owner";
import { ppmToPercentString } from "@/lib/money";
import { formatDateTime } from "@/lib/labels";
import { PageHeader } from "@/components/layout/app-shell";
import { ActionForm } from "@/components/dashboard/action-form";
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, NativeSelect, TBody, THead, TR, Table, Textarea } from "@/components/ui/primitives";
import { createRuleAction } from "../actions";

export const metadata = { title: "Regras de comissão" };

export default async function SettingsPage() {
  await requireOwnerPage("platform:commission:write");
  const db = getDb();
  const [rules, orgs] = await Promise.all([listRules(db), listOrganizations(db)]);
  const now = new Date();
  const defaultStart = new Date(now.getTime() + 2 * 3600_000 + 60 * 60_000).toISOString().slice(0, 16); // ~1h ahead (Maputo)

  return (
    <>
      <PageHeader title="Regras de comissão" description="commission = eligible_payment_amount × contracted_rate · versões imutáveis com datas de vigência" />
      <Alert tone="warning" className="mb-4">
        A taxa de 0,5% é um valor <strong>fictício de demonstração</strong>. Uma nova versão só se aplica a pagamentos que fiquem elegíveis depois do seu início; comissões já
        acumuladas mantêm o snapshot da regra em vigor nesse momento.
      </Alert>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <History className="size-4" /> Histórico de versões
            </CardTitle>
          </CardHeader>
          <Table>
            <THead>
              <tr>
                <th>Organização</th>
                <th>Versão</th>
                <th className="text-right">Taxa</th>
                <th>Vigência</th>
                <th>Estado</th>
                <th>Contrato</th>
              </tr>
            </THead>
            <TBody>
              {rules.map(({ rule: r, organization, createdByName }) => {
                const inForce = r.effectiveFrom <= now && (!r.effectiveTo || r.effectiveTo > now) && r.status !== "draft";
                return (
                  <TR key={r.id}>
                    <td>{organization}</td>
                    <td className="font-mono text-xs">v{r.version}</td>
                    <td className="text-right font-semibold tabular">{ppmToPercentString(r.ratePpm)}%</td>
                    <td className="text-xs">
                      {formatDateTime(r.effectiveFrom)} → {r.effectiveTo ? formatDateTime(r.effectiveTo) : "sem fim"}
                    </td>
                    <td>
                      {inForce ? (
                        <Badge tone="success" dot>
                          Em vigor
                        </Badge>
                      ) : r.effectiveFrom > now ? (
                        <Badge tone="info" dot>
                          Agendada
                        </Badge>
                      ) : (
                        <Badge dot>Histórica</Badge>
                      )}
                    </td>
                    <td className="text-xs">
                      <span className="font-mono">{r.contractReference}</span>
                      {createdByName && <span className="block text-[11px] text-muted-foreground">por {createdByName}</span>}
                    </td>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </Card>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Percent className="size-4" /> Nova versão de regra
            </CardTitle>
            <CardDescription>Sem efeitos retroactivos: o início tem de ser no futuro.</CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={createRuleAction} submitLabel="Publicar nova versão" confirm="Publicar uma nova versão da regra de comissão?">
              <div className="space-y-1.5">
                <Label htmlFor="r-org">Organização</Label>
                <NativeSelect id="r-org" name="organizationId">
                  {orgs.map((o) => (
                    <option key={o.org.id} value={o.org.id}>
                      {o.org.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="r-pct">Taxa contratada (%)</Label>
                <Input id="r-pct" name="percent" inputMode="decimal" defaultValue="0.5" required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="r-from">Início da vigência (hora de Maputo)</Label>
                <Input id="r-from" name="effectiveFrom" type="datetime-local" defaultValue={defaultStart} required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="r-to">Expiração (opcional)</Label>
                <Input id="r-to" name="effectiveTo" type="datetime-local" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="r-ctr">Referência do contrato</Label>
                <Input id="r-ctr" name="contractReference" placeholder="DEMO-CTR-INSURER-002" required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="r-notes">Notas</Label>
                <Textarea id="r-notes" name="notes" maxLength={500} />
              </div>
            </ActionForm>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
