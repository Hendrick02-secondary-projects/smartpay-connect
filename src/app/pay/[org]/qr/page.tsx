import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { Download, ScanLine } from "lucide-react";
import { getDb } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { paymentPortalUrl, portalQrSvg } from "@/lib/qr";
import { DemoBanner } from "@/components/layout/demo-banner";
import { TenantPortalMark } from "@/components/layout/brand";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "QR de pagamento (demo)" };

export default async function QrPage({ params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const [org] = await getDb().select().from(organizations).where(eq(organizations.slug, slug)).limit(1);
  if (!org) notFound();
  const svg = await portalQrSvg(org.slug);
  const url = paymentPortalUrl(org.slug);

  return (
    <div className="min-h-dvh">
      <DemoBanner />
      <main className="mx-auto flex max-w-md flex-col items-center px-4 py-10 text-center">
        <TenantPortalMark name={org.portalName} />
        <div className="mt-8 rounded-3xl border-[10px] border-primary bg-white p-5 shadow-xl">
          <div className="size-64" dangerouslySetInnerHTML={{ __html: svg }} />
        </div>
        <p className="mt-6 flex items-center gap-2 text-lg font-semibold">
          <ScanLine className="size-5 text-primary" /> Aponte a câmara para pagar
        </p>
        <p className="mt-1 text-sm text-muted-foreground">QR permanente — leva sempre ao portal de pagamento:</p>
        <p className="mt-1 break-all font-mono text-xs">{url}</p>
        <Button asChild variant="outline" className="no-print mt-6">
          <a href={`/api/qr/${org.slug}`}>
            <Download /> Descarregar QR (SVG)
          </a>
        </Button>
        <p className="mt-8 max-w-xs text-[11px] text-muted-foreground">
          Material de demonstração. Não está autorizado nem implementado pela seguradora. Pagamentos simulados.
        </p>
      </main>
    </div>
  );
}
