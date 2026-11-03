import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { DemoBanner } from "@/components/layout/demo-banner";
import { SmartPayLogo } from "@/components/layout/brand";
import { LoginForm } from "@/components/layout/login-form";
import { Card, CardContent } from "@/components/ui/primitives";
import { getCurrentPrincipal } from "@/lib/auth/session";
import { isPlatformOwner } from "@/lib/auth/policy";

// Not linked from any public page; also excluded from indexing.
export const metadata: Metadata = { title: "Consola da plataforma", robots: { index: false, follow: false } };

export default async function OwnerLoginPage() {
  const principal = await getCurrentPrincipal();
  if (principal && isPlatformOwner(principal)) redirect("/owner/dashboard");

  return (
    <div className="flex min-h-dvh flex-col bg-secondary/[0.03]">
      <DemoBanner />
      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex flex-col items-center text-center">
            <SmartPayLogo />
            <h1 className="mt-6 flex items-center gap-2 text-xl font-semibold tracking-tight">
              <ShieldCheck className="size-5 text-primary" /> Consola da plataforma
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">Apenas contas de proprietário da plataforma.</p>
          </div>
          <Card>
            <CardContent className="p-6">
              <LoginForm portal="owner" />
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
