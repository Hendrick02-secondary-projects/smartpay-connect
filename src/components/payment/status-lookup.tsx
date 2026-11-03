"use client";

import { useEffect, useState } from "react";
import { LockKeyhole } from "lucide-react";
import { EmptyState } from "@/components/ui/primitives";
import { PaymentResult } from "./payment-result";
import { readSecret } from "./secret-store";

/** Re-opens a payment's status/confirmation on the device where it was made. */
export function StatusLookup({ orgSlug, reference }: { orgSlug: string; reference: string }) {
  const [secret, setSecret] = useState<string | null | undefined>(undefined);
  useEffect(() => setSecret(readSecret(reference)), [reference]);

  if (secret === undefined) return null;
  if (!secret) {
    return (
      <EmptyState
        icon={<LockKeyhole />}
        title="Confirmação indisponível neste dispositivo"
        description="Por segurança, os detalhes de um pagamento só podem ser consultados no dispositivo e sessão onde foi efectuado."
      />
    );
  }
  return <PaymentResult orgSlug={orgSlug} reference={reference} clientSecret={secret} initialStatus={null} />;
}
