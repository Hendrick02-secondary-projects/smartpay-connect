import type { Metadata } from "next";
import { DemoBanner } from "@/components/layout/demo-banner";
import { StatusLookup } from "@/components/payment/status-lookup";

export const metadata: Metadata = { title: "Estado do pagamento (demo)" };

export default async function StatusPage({ params }: { params: Promise<{ org: string; reference: string }> }) {
  const { org, reference } = await params;
  return (
    <div className="min-h-dvh">
      <DemoBanner />
      <main className="mx-auto max-w-lg px-4 py-8">
        <StatusLookup orgSlug={org} reference={reference.toUpperCase()} />
      </main>
    </div>
  );
}
