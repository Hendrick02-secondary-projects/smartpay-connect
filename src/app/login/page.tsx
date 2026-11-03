import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { DemoBanner } from "@/components/layout/demo-banner";
import { SmartPayLogo } from "@/components/layout/brand";
import { LoginForm } from "@/components/layout/login-form";
import { Card, CardContent } from "@/components/ui/primitives";
import { getCurrentPrincipal } from "@/lib/auth/session";
import { isPlatformOwner } from "@/lib/auth/policy";

export const metadata: Metadata = { title: "Entrar — Área financeira" };

export default async function LoginPage() {
  const principal = await getCurrentPrincipal();
  if (principal) redirect(isPlatformOwner(principal) ? "/owner/dashboard" : "/finance/dashboard");

  return (
    <div className="flex min-h-dvh flex-col">
      <DemoBanner />
      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex flex-col items-center text-center">
            <SmartPayLogo />
            <h1 className="mt-6 text-xl font-semibold tracking-tight">Área financeira</h1>
            <p className="mt-1 text-sm text-muted-foreground">Acesso restrito a utilizadores autorizados da organização cliente.</p>
          </div>
          <Card>
            <CardContent className="p-6">
              <LoginForm portal="tenant" />
            </CardContent>
          </Card>
          <p className="mt-6 text-center text-xs text-muted-foreground">
            Procura o portal de pagamento?{" "}
            <Link href="/pay/demo" className="font-medium text-primary hover:underline">
              Pagar agora
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
