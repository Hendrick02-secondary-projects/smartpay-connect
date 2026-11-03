"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { ClipboardCheck, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Label, NativeSelect, Textarea } from "@/components/ui/primitives";

export function ReviewDialog({ recordId, settlementReference, canReconcile }: { recordId: string; settlementReference: string; canReconcile: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState(canReconcile ? "manually_reconciled" : "rejected");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/finance/reconciliation/records/${recordId}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.details?.[0]?.message ?? data?.error?.message ?? "Falha ao gravar a revisão.");
      setOpen(false);
      setReason("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro inesperado.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button size="sm" variant="outline">
          <ClipboardCheck /> Rever
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-card p-6 shadow-2xl">
          <div className="mb-4 flex items-start justify-between">
            <div>
              <Dialog.Title className="text-base font-semibold">Revisão manual</Dialog.Title>
              <Dialog.Description className="mt-1 font-mono text-xs text-muted-foreground">{settlementReference}</Dialog.Description>
            </div>
            <Dialog.Close className="rounded-md p-1 hover:bg-muted" aria-label="Fechar">
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor={`d-${recordId}`}>Decisão</Label>
              <NativeSelect id={`d-${recordId}`} value={decision} onChange={(e) => setDecision(e.target.value)}>
                {canReconcile && <option value="manually_reconciled">Reconciliar manualmente</option>}
                <option value="rejected">Rejeitar linha de liquidação</option>
                <option value="under_review">Manter em revisão</option>
              </NativeSelect>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`r-${recordId}`}>Motivo (obrigatório, fica no registo de auditoria)</Label>
              <Textarea id={`r-${recordId}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Ex.: Diferença confirmada com o banco — taxa interbancária de 100 MZN." />
              <p className="text-right text-[11px] text-muted-foreground">{reason.trim().length}/500 (mín. 10)</p>
            </div>
            {error && <Alert tone="danger" title={error} />}
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button variant="ghost">Cancelar</Button>
              </Dialog.Close>
              <Button onClick={submit} disabled={busy || reason.trim().length < 10}>
                {busy && <Loader2 className="animate-spin" />} Gravar revisão
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
