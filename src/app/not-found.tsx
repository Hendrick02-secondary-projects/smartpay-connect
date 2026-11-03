import Link from "next/link";
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/primitives";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <EmptyState
        icon={<Compass />}
        title="Página não encontrada"
        description="O endereço não existe ou não tem permissão para o ver."
        action={
          <Button asChild variant="outline">
            <Link href="/">Voltar ao início</Link>
          </Button>
        }
      />
    </main>
  );
}
