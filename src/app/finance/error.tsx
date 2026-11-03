"use client";

import { RefreshCw, ServerCrash } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, EmptyState } from "@/components/ui/primitives";

/**
 * Transient failures (e.g. a database hiccup) land here with a retry — the user
 * is NOT logged out or redirected to the login page.
 */
export default function DashboardError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Card>
      <EmptyState
        icon={<ServerCrash />}
        title="Não foi possível carregar esta página"
        description="Ocorreu um erro temporário. A sua sessão continua activa — tente novamente."
        action={
          <Button onClick={reset}>
            <RefreshCw /> Tentar novamente
          </Button>
        }
      />
    </Card>
  );
}
