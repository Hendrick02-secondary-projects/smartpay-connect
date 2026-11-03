"use client";

import { RefreshCw, ServerCrash } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/primitives";

/** Root error boundary: safe message only, never internals; no forced logout. */
export default function RootError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <EmptyState
        icon={<ServerCrash />}
        title="Algo correu mal"
        description="Ocorreu um erro temporário. Tente novamente dentro de instantes."
        action={
          <Button onClick={reset}>
            <RefreshCw /> Tentar novamente
          </Button>
        }
      />
    </main>
  );
}
