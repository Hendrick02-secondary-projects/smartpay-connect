"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, FlaskConical, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle, NativeSelect } from "@/components/ui/primitives";

type ApiResult = { batchReference: string; counts?: Record<string, number>; exceptions?: number; pending?: boolean; payments?: number; lines?: number };
type ApiError = { message: string; details?: { row: number; message: string }[] };

const SCENARIOS = [
  { key: "gross", label: "Liquidação bruta" },
  { key: "net", label: "Liquidação líquida" },
  { key: "separate_fee_debit", label: "Débito de taxas separado" },
  { key: "aggregated", label: "Liquidação agregada" },
  { key: "reversal", label: "Reversões" },
];

export function ReconActions() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"upload" | "simulate" | null>(null);
  const [scenario, setScenario] = useState("gross");
  const [result, setResult] = useState<ApiResult | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  async function handle(kind: "upload" | "simulate", req: () => Promise<Response>) {
    setBusy(kind);
    setError(null);
    setResult(null);
    try {
      const res = await req();
      const data = await res.json();
      if (!res.ok) {
        setError({ message: data?.error?.message ?? "Operação falhou.", details: Array.isArray(data?.error?.details) ? data.error.details : undefined });
        return;
      }
      setResult(data);
      router.refresh();
    } catch {
      setError({ message: "Erro de rede. Tente novamente." });
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError({ message: "Seleccione um ficheiro .csv ou .xlsx." });
      return;
    }
    const fd = new FormData();
    fd.set("file", file);
    void handle("upload", () => fetch("/api/finance/reconciliation/import", { method: "POST", body: fd }));
  }

  function simulate() {
    void handle("simulate", () =>
      fetch("/api/finance/reconciliation/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario, limit: 25 }),
      }),
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="size-4" /> Importar ficheiro de liquidação
          </CardTitle>
          <CardDescription>Ficheiro normalizado .csv ou .xlsx (máx. 2 MB). Um ficheiro idêntico não pode ser importado duas vezes.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary-soft file:px-3 file:py-2 file:text-sm file:font-medium file:text-primary"
            aria-label="Ficheiro de liquidação"
          />
          <div className="flex flex-wrap gap-2">
            <Button onClick={upload} disabled={!!busy}>
              {busy === "upload" ? <Loader2 className="animate-spin" /> : <Upload />} Importar e reconciliar
            </Button>
            <Button asChild variant="outline">
              <a href="/api/finance/reconciliation/template">
                <Download /> Ficheiro de exemplo
              </a>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FlaskConical className="size-4" /> Gerar liquidação simulada
          </CardTitle>
          <CardDescription>O fornecedor simulado envia a liquidação de até 25 pagamentos ainda sem liquidação. O lote fica por reconciliar até carregar em “Reconciliar lote”.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <NativeSelect value={scenario} onChange={(e) => setScenario(e.target.value)} aria-label="Cenário de liquidação">
            {SCENARIOS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </NativeSelect>
          <Button variant="secondary" onClick={simulate} disabled={!!busy}>
            {busy === "simulate" ? <Loader2 className="animate-spin" /> : <FlaskConical />} Receber liquidação simulada
          </Button>
        </CardContent>
      </Card>

      {(result || error) && (
        <div className="lg:col-span-2">
          {result && result.pending && (
            <Alert tone="info" title={`Lote ${result.batchReference} recebido — por reconciliar`}>
              {result.lines} linha(s) para {result.payments} pagamento(s). Reconcilie o lote na secção “Lotes por reconciliar”.
            </Alert>
          )}
          {result && result.counts && (
            <Alert tone={result.exceptions ? "warning" : "success"} title={`Lote ${result.batchReference} processado`}>
              {result.counts.matched ?? 0} correspondidos · {result.counts.amount_mismatch ?? 0} valor divergente · {result.counts.unmatched ?? 0} sem correspondência ·{" "}
              {result.counts.duplicate_settlement ?? 0} duplicados · {result.counts.under_review ?? 0} em revisão
            </Alert>
          )}
          {error && (
            <Alert tone="danger" title={error.message}>
              {error.details && (
                <ul className="mt-1 list-disc pl-4">
                  {error.details.slice(0, 8).map((d, i) => (
                    <li key={i}>
                      Linha {d.row}: {d.message}
                    </li>
                  ))}
                </ul>
              )}
            </Alert>
          )}
        </div>
      )}
    </div>
  );
}
