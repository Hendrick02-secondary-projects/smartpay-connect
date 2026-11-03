"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Clock3, Download, Loader2, Printer, RotateCcw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Card, CardContent, Skeleton } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatMzn } from "@/lib/money";
import { METHOD_LABELS, formatDateTime, formatPhone } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { SimulatedCheckout } from "./simulated-checkout";

export interface PaymentView {
  reference: string;
  status: string;
  customerName: string;
  customerPhone: string;
  method: string;
  amountMinor: number;
  currency: string;
  createdAt: string;
  completedAt: string | null;
  failureReason: string | null;
  isSimulated: boolean;
  account: { bankName: string; accountName: string; accountNumberMasked: string } | null;
  debitNotes: { number: string; amountMinor: number }[];
}

const FAILURE_LABELS: Record<string, string> = {
  INSUFFICIENT_FUNDS: "Saldo insuficiente (simulado)",
  DECLINED_BY_ISSUER: "Recusado pelo emissor (simulado)",
  CANCELLED_BY_CUSTOMER: "Cancelado pelo cliente (simulado)",
  TIMEOUT_NO_CUSTOMER_CONFIRMATION: "Expirou sem confirmação (simulado)",
};

export function PaymentResult({
  orgSlug,
  reference,
  clientSecret,
  initialStatus,
}: {
  orgSlug: string;
  reference: string;
  clientSecret: string;
  initialStatus: string | null;
}) {
  const [view, setView] = useState<PaymentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const res = await fetch(`/api/pay/${orgSlug}/intents/${reference}/view`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientSecret }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data?.error?.message ?? "Não foi possível obter o estado do pagamento.");
      return;
    }
    setView(data as PaymentView);
  }, [orgSlug, reference, clientSecret]);

  useEffect(() => {
    void load();
  }, [load]);

  // While the provider has not answered, poll the status (e.g. the payment is confirmed
  // from another device in the Demo Control Center). Stops on any final status.
  useEffect(() => {
    if (view?.status !== "pending") return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 6000);
    return () => window.clearInterval(id);
  }, [view?.status, load]);

  async function resolve(resolution: "approve" | "decline" | "cancel") {
    setResolving(resolution);
    try {
      const res = await fetch(`/api/pay/${orgSlug}/intents/${reference}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientSecret, resolution }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message ?? "Falha na simulação.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro inesperado.");
    } finally {
      setResolving(null);
    }
  }

  if (error) return <Alert tone="danger" title={error} />;
  if (!view) return <ResultSkeleton status={initialStatus} />;
  if (view.status === "created") {
    // Page was reloaded during checkout: resume the simulated checkout.
    return (
      <SimulatedCheckout
        orgSlug={orgSlug}
        reference={reference}
        clientSecret={clientSecret}
        method={view.method as "card" | "mpesa" | "emola"}
        phone={view.customerPhone}
        amountMinor={view.amountMinor}
        onDone={() => void load()}
      />
    );
  }

  const tone = view.status === "successful" ? "success" : view.status === "pending" || view.status === "created" ? "warning" : "danger";

  return (
    <section className="space-y-5">
      <div className="no-print flex flex-col items-center pt-2 text-center">
        <span
          className={cn(
            "flex size-16 items-center justify-center rounded-full [&_svg]:size-8",
            tone === "success" && "bg-success-soft text-success",
            tone === "warning" && "bg-warning-soft text-warning",
            tone === "danger" && "bg-danger-soft text-danger",
          )}
        >
          {tone === "success" ? <CheckCircle2 /> : tone === "warning" ? <Clock3 /> : <XCircle />}
        </span>
        <h1 className="mt-4 text-xl font-semibold tracking-tight">
          {view.status === "successful" && "Pagamento simulado concluído"}
          {view.status === "pending" && "Pagamento pendente"}
          {view.status === "created" && "Pagamento por confirmar"}
          {view.status === "failed" && "Pagamento não concluído"}
          {view.status === "cancelled" && "Pagamento cancelado"}
          {view.status === "reversed" && "Pagamento revertido"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {view.status === "successful" && "A confirmação abaixo é apenas demonstrativa."}
          {view.status === "pending" && "A aguardar a resposta (simulada) do fornecedor de pagamento. Esta página actualiza-se sozinha."}
          {view.status === "failed" && (FAILURE_LABELS[view.failureReason ?? ""] ?? "O fornecedor simulado recusou o pagamento.")}
          {view.status === "cancelled" && (FAILURE_LABELS[view.failureReason ?? ""] ?? "O pagamento foi cancelado.")}
        </p>
      </div>

      {view.status === "pending" && (
        <Card className="no-print border-dashed">
          <CardContent className="space-y-3 p-4">
            <p className="text-xs font-medium text-muted-foreground">Controlo de demonstração — simular resposta assíncrona do fornecedor:</p>
            <div className="grid grid-cols-3 gap-2">
              <Button size="sm" onClick={() => resolve("approve")} disabled={!!resolving}>
                {resolving === "approve" && <Loader2 className="animate-spin" />} Aprovar
              </Button>
              <Button size="sm" variant="outline" onClick={() => resolve("decline")} disabled={!!resolving}>
                Recusar
              </Button>
              <Button size="sm" variant="outline" onClick={() => resolve("cancel")} disabled={!!resolving}>
                Expirar
              </Button>
            </div>
            <Button size="sm" variant="ghost" className="w-full" onClick={() => load()}>
              <RotateCcw /> Actualizar estado
            </Button>
          </CardContent>
        </Card>
      )}

      <DemoConfirmation view={view} />

      <div className="no-print grid grid-cols-2 gap-3">
        <Button variant="outline" onClick={() => window.print()}>
          <Printer /> Imprimir / PDF
        </Button>
        <Button variant="outline" onClick={() => downloadText(view)}>
          <Download /> Descarregar
        </Button>
      </div>
      <Button variant="ghost" className="no-print w-full" onClick={() => (window.location.href = `/pay/${orgSlug}`)}>
        Fazer outro pagamento
      </Button>
    </section>
  );
}

export function DemoConfirmation({ view }: { view: PaymentView }) {
  return (
    <Card className="relative overflow-hidden print:shadow-none">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 flex items-center justify-center text-[42px] font-black uppercase tracking-widest text-danger/[0.07] [transform:rotate(-24deg)]"
      >
        Demonstração
      </div>
      <div className="border-b-2 border-dashed border-danger/40 bg-danger-soft px-4 py-3 text-center">
        <p className="text-[13px] font-extrabold uppercase tracking-wide text-danger">Demonstração — não é um comprovativo de pagamento válido</p>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-danger/80">Demonstration — not a valid proof of payment</p>
      </div>
      <CardContent className="relative space-y-0 divide-y p-0 text-sm">
        <Row label="Referência" value={<span className="font-mono">{view.reference}</span>} />
        <Row label="Estado" value={<StatusBadge kind="payment" value={view.status} />} />
        <Row label="Segurado" value={view.customerName} />
        <Row label="Telemóvel" value={formatPhone(view.customerPhone)} />
        <Row label="Método" value={`${METHOD_LABELS[view.method] ?? view.method} (simulado)`} />
        <Row label="Conta de destino" value={view.account ? `${view.account.bankName} · ${view.account.accountNumberMasked}` : "—"} />
        <Row label="Data/hora" value={formatDateTime(view.completedAt ?? view.createdAt)} />
        <div className="px-4 py-3">
          <p className="mb-2 text-xs text-muted-foreground">Notas de débito (introduzidas pelo cliente, não verificadas)</p>
          <ul className="space-y-1">
            {view.debitNotes.map((d) => (
              <li key={d.number} className="flex justify-between font-mono text-[13px]">
                <span>{d.number}</span>
                <span className="tabular">{formatMzn(d.amountMinor)}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex items-center justify-between bg-muted/50 px-4 py-3">
          <span className="font-semibold">Valor</span>
          <span className="text-lg font-bold tabular">{formatMzn(view.amountMinor)}</span>
        </div>
      </CardContent>
      <p className="relative px-4 py-3 text-center text-[10px] text-muted-foreground">
        Gerado pela demonstração SmartPay Connect com um gateway simulado. Nenhum valor foi movimentado. Não representa um serviço autorizado ou operado pela seguradora.
      </p>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

function ResultSkeleton({ status }: { status: string | null }) {
  return (
    <div className="space-y-4" aria-busy="true" aria-label={status ? `Estado: ${status}` : "A carregar"}>
      <Skeleton className="mx-auto size-16 rounded-full" />
      <Skeleton className="mx-auto h-6 w-48" />
      <Skeleton className="h-72 w-full rounded-xl" />
    </div>
  );
}

function downloadText(v: PaymentView) {
  const lines = [
    "==============================================================",
    " DEMONSTRAÇÃO — NÃO É UM COMPROVATIVO DE PAGAMENTO VÁLIDO",
    " DEMONSTRATION — NOT A VALID PROOF OF PAYMENT",
    "==============================================================",
    `Referência:        ${v.reference}`,
    `Estado:            ${v.status}`,
    `Segurado:          ${v.customerName}`,
    `Telemóvel:         ${v.customerPhone}`,
    `Método:            ${METHOD_LABELS[v.method] ?? v.method} (simulado)`,
    `Conta de destino:  ${v.account ? `${v.account.bankName} ${v.account.accountNumberMasked}` : "-"}`,
    `Data/hora:         ${formatDateTime(v.completedAt ?? v.createdAt)}`,
    "Notas de débito (introduzidas pelo cliente, não verificadas):",
    ...v.debitNotes.map((d) => `  - ${d.number.padEnd(24)} ${formatMzn(d.amountMinor).replace(/ /g, " ")}`),
    `Valor total:       ${formatMzn(v.amountMinor).replace(/ /g, " ")}`,
    "--------------------------------------------------------------",
    "Gerado por um gateway SIMULADO. Nenhum valor foi movimentado.",
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `DEMO-confirmacao-${v.reference}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}
