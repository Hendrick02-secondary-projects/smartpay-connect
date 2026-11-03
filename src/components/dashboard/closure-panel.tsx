"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Lock, LockOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Label, Textarea } from "@/components/ui/primitives";

/**
 * Close / reopen one side of the process. `endpoint` is the tenant API route for the
 * operational closure; the owner console passes Server Actions instead (see owner demo).
 */
export function ClosurePanel({
  closed,
  canClose,
  reasons,
  endpoint,
  closeLabel,
  closedLabel,
}: {
  closed: boolean;
  canClose: boolean;
  reasons: string[];
  endpoint: string;
  closeLabel: string;
  closedLabel: string;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function send(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.details?.[0]?.message ?? data?.error?.message ?? "Operação falhou.");
      setText("");
      setConfirming(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro inesperado.");
    } finally {
      setBusy(false);
    }
  }

  if (closed) {
    return (
      <div className="space-y-3">
        <Alert tone="success" icon={<Lock />} title={closedLabel} />
        {confirming ? (
          <div className="space-y-2">
            <Label htmlFor="reopen-reason">Motivo da reabertura</Label>
            <Textarea id="reopen-reason" value={text} onChange={(e) => setText(e.target.value)} maxLength={500} placeholder="Ex.: Recibo KIT emitido com valor errado." />
            {error && <Alert tone="danger" title={error} />}
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => send({ action: "reopen", reason: text })} disabled={busy || text.trim().length < 10}>
                {busy && <Loader2 className="animate-spin" />} Confirmar reabertura
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Cancelar
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
            <LockOpen /> Reabrir
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {!canClose && reasons.length > 0 && (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {reasons.map((r) => (
            <li key={r}>• {r}</li>
          ))}
        </ul>
      )}
      {canClose && (
        <div className="space-y-2">
          <Label htmlFor="close-notes">Observações (opcional)</Label>
          <Textarea id="close-notes" value={text} onChange={(e) => setText(e.target.value)} maxLength={500} />
        </div>
      )}
      {error && <Alert tone="danger" title={error} />}
      <Button className="w-full" onClick={() => send({ action: "close", notes: text || null })} disabled={!canClose || busy}>
        {busy ? <Loader2 className="animate-spin" /> : <Lock />} {closeLabel}
      </Button>
    </div>
  );
}
