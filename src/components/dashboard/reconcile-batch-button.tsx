"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Scale } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ReconcileBatchButton({ batchId, label = "Reconciliar lote" }: { batchId: string; label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function run() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/finance/reconciliation/batches/${batchId}/reconcile`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message ?? "Falha na reconciliação.");
      setMsg({ ok: true, text: `${data.counts.matched} correspondidos · ${data.exceptions} excepções` });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Erro inesperado." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button size="sm" onClick={run} disabled={busy}>
        {busy ? <Loader2 className="animate-spin" /> : <Scale />} {label}
      </Button>
      {msg && <span className={msg.ok ? "text-xs text-success" : "text-xs text-danger"}>{msg.text}</span>}
    </span>
  );
}
