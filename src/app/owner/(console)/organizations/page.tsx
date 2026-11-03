import Link from "next/link";
import { Building2, ExternalLink, QrCode } from "lucide-react";
import { getDb } from "@/lib/db";
import { requireOwnerPage } from "@/lib/auth/session";
import { listOrganizations } from "@/lib/queries/owner";
import { ppmToPercentString } from "@/lib/money";
import { PageHeader } from "@/components/layout/app-shell";
import { ActionForm } from "@/components/dashboard/action-form";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card, CardContent } from "@/components/ui/primitives";
import { toggleOrganizationAction } from "../actions";

export const metadata = { title: "Organizações" };

export default async function OrganizationsPage() {
  await requireOwnerPage("platform:organizations:manage");
  const orgs = await listOrganizations(getDb());
  return (
    <>
      <PageHeader title="Organizações" description="Clientes (tenants) da plataforma — V1 demonstra um único tenant" />
      <Alert tone="info" className="mb-4">
        A arquitectura é multi-tenant (todas as tabelas têm <span className="font-mono">organization_id</span> e todas as consultas são filtradas pelo tenant da sessão). A V1
        apresenta uma demonstração estável com um único tenant.
      </Alert>
      <div className="grid gap-4 md:grid-cols-2">
        {orgs.map((o) => (
          <Card key={o.org.id}>
            <CardContent className="space-y-4 p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="flex size-10 items-center justify-center rounded-lg bg-primary-soft text-primary">
                    <Building2 className="size-5" />
                  </span>
                  <div>
                    <p className="font-semibold">{o.org.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Portal: {o.org.portalName} · <span className="font-mono">/pay/{o.org.slug}</span>
                    </p>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  {o.org.isDemo && <Badge tone="warning">Demo</Badge>}
                  <Badge tone={o.org.isActive ? "success" : "neutral"} dot>
                    {o.org.isActive ? "Activo" : "Inactivo"}
                  </Badge>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center text-sm">
                <div className="rounded-lg bg-muted p-2">
                  <p className="font-semibold tabular">{o.payments}</p>
                  <p className="text-[11px] text-muted-foreground">pagamentos</p>
                </div>
                <div className="rounded-lg bg-muted p-2">
                  <p className="font-semibold tabular">{o.users}</p>
                  <p className="text-[11px] text-muted-foreground">utilizadores</p>
                </div>
                <div className="rounded-lg bg-muted p-2">
                  <p className="font-semibold tabular">{o.activeRate === null ? "—" : `${ppmToPercentString(o.activeRate)}%`}</p>
                  <p className="text-[11px] text-muted-foreground">comissão em vigor</p>
                </div>
              </div>
              <div className="flex flex-wrap items-start gap-2">
                <Button asChild variant="outline" size="sm">
                  <Link href={`/pay/${o.org.slug}`} target="_blank">
                    <ExternalLink /> Portal
                  </Link>
                </Button>
                <Button asChild variant="outline" size="sm">
                  <Link href={`/pay/${o.org.slug}/qr`} target="_blank">
                    <QrCode /> QR
                  </Link>
                </Button>
                <ActionForm action={toggleOrganizationAction} submitLabel={o.org.isActive ? "Desactivar portal" : "Activar portal"} variant="outline" className="space-y-2">
                  <input type="hidden" name="organizationId" value={o.org.id} />
                </ActionForm>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
