"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { FileCheck2, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label, NativeSelect, Textarea } from "@/components/ui/primitives";
import { KIT_ACTION_LABELS, type KitAction, type KitStatus } from "@/lib/kit/allocation";
import { formatMzn } from "@/lib/money";

const ACTIONS_BY_STATUS: Record<KitStatus, KitAction[]> = {
  pending: ["allocate", "flag_issue"],
  issue: ["allocate", "reset"],
  allocated: ["reset"],
  voided: [],
};

export interface AllocationRow {
  id: string;
  status: KitStatus;
  version: number;
  debitNoteNumber: string;
  amountMinor: number;
  receiptReference: string | null;
}

/**
 * Finance dialog to change ONE debit note's KIT allocation. The server re-validates
 * everything (permission, tenant, version, reconciliation, closure).
 */
export function AllocationDialog({
  row,
  paymentReversed,
  locked,
  today,
  triggerLabel,
}: {
  row: AllocationRow;
  paymentReversed: boolean;
  locked: boolean;
  today: string;
  triggerLabel?: string;
}) {
  const router = useRouter();
  const actions = paymentReversed ? (row.status === "voided" ? [] : (["void"] as KitAction[])) : ACTIONS_BY_STATUS[row.status];
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<KitAction>(actions[0] ?? "allocate");
  const [receipt, setReceipt] = useState("");
  const [date, setDate] = useState(today);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (actions.length === 0 || locked) return null;
  const needsReason = action !== "allocate";

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/finance/allocations/${row.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, expectedVersion: row.version, receiptReference: receipt || null, allocatedOn: action === "allocate" ? date : null, notes: notes || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.details?.[0]?.message ?? data?.error?.message ?? "Não foi possível gravar.");
      setOpen(false);
      setReceipt("");
      setNotes("");
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
        <Button size="sm" variant={row.status === "pending" && !paymentReversed ? "default" : "outline"}>
          <FileCheck2 /> {triggerLabel ?? (paymentReversed ? "Anular no KIT" : row.status === "pending" ? "Alocar" : "Gerir")}
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-card p-6 shadow-2xl">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="text-base font-semibold">Alocação de Pagamentos</Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-muted-foreground">
                <span className="font-mono">{row.debitNoteNumber}</span> · {formatMzn(row.amountMinor)}
              </Dialog.Description>
            </div>
            <Dialog.Close className="rounded-md p-1 hover:bg-muted" aria-label="Fechar">
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <div className="space-y-4">
            {actions.length > 1 && (
              <div className="space-y-2">
                <Label htmlFor={`act-${row.id}`}>Acção</Label>
                <NativeSelect id={`act-${row.id}`} value={action} onChange={(e) => setAction(e.target.value as KitAction)}>
                  {actions.map((a) => (
                    <option key={a} value={a}>
                      {KIT_ACTION_LABELS[a]}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            )}
            {action === "allocate" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor={`rec-${row.id}`}>Nº do recibo KIT</Label>
                  <Input id={`rec-${row.id}`} value={receipt} onChange={(e) => setReceipt(e.target.value)} className="font-mono uppercase" placeholder="KIT-REC-000123" maxLength={40} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`dt-${row.id}`}>Data da alocação</Label>
                  <Input id={`dt-${row.id}`} type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
                </div>
              </div>
            )}
            {action === "void" && (
              <div className="space-y-2">
                <Label htmlFor={`rev-${row.id}`}>Referência da anulação no KIT (opcional)</Label>
                <Input id={`rev-${row.id}`} value={receipt} onChange={(e) => setReceipt(e.target.value)} className="font-mono uppercase" placeholder="KIT-ANUL-000045" maxLength={40} />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor={`nt-${row.id}`}>{needsReason ? "Motivo (obrigatório)" : "Observações (opcional)"}</Label>
              <Textarea id={`nt-${row.id}`} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} placeholder={needsReason ? "Ex.: ND não encontrada no KIT — confirmar com a área técnica." : ""} />
              {needsReason && <p className="text-right text-[11px] text-muted-foreground">{notes.trim().length}/500 (mín. 10)</p>}
            </div>
            <Alert tone="info">A alteração fica registada com o seu nome, data e hora na linha temporal da transacção.</Alert>
            {error && <Alert tone="danger" title={error} />}
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button variant="ghost">Cancelar</Button>
              </Dialog.Close>
              <Button onClick={submit} disabled={busy || (needsReason && notes.trim().length < 10) || (action === "allocate" && (!receipt.trim() || !date))}>
                {busy && <Loader2 className="animate-spin" />} {KIT_ACTION_LABELS[action]}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
