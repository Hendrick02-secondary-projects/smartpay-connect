"use client";

import { useState } from "react";
import { BellRing, CreditCard, FlaskConical, Loader2, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Card, CardContent } from "@/components/ui/primitives";
import { formatMzn } from "@/lib/money";
import { METHOD_LABELS } from "@/lib/labels";
import { cn } from "@/lib/utils";

type Scenario = "approve" | "decline" | "insufficient_funds" | "pending" | "cancel";

const CARD_TEST_PROFILES: { scenario: Scenario; label: string; hint: string }[] = [
  { scenario: "approve", label: "Cartão de teste — Aprovado", hint: "Resultado: pagamento bem-sucedido" },
  { scenario: "decline", label: "Cartão de teste — Recusado", hint: "Resultado: recusado pelo emissor" },
  { scenario: "insufficient_funds", label: "Cartão de teste — Sem saldo", hint: "Resultado: saldo insuficiente" },
  { scenario: "pending", label: "Cartão de teste — Autenticação pendente", hint: "Resultado: fica pendente (3-D Secure simulado)" },
  { scenario: "cancel", label: "Cancelar no checkout", hint: "Resultado: cancelado pelo cliente" },
];

const MOBILE_TEST_PROFILES: { scenario: Scenario; label: string; hint: string }[] = [
  { scenario: "approve", label: "Cliente aprova no telemóvel", hint: "Número de teste terminado em 0001" },
  { scenario: "insufficient_funds", label: "Saldo insuficiente", hint: "Número de teste terminado em 0002" },
  { scenario: "pending", label: "Sem resposta (fica pendente)", hint: "Número de teste terminado em 0003" },
  { scenario: "cancel", label: "Cliente rejeita o pedido", hint: "Número de teste terminado em 0004" },
];

/**
 * SIMULATED checkout. Never renders card-number / expiry / CVV fields and never
 * triggers a real mobile-money authorisation. The tester picks the outcome.
 */
export function SimulatedCheckout(props: {
  orgSlug: string;
  reference: string;
  clientSecret: string;
  method: "card" | "mpesa" | "emola";
  phone: string;
  amountMinor: number;
  onDone: (status: string) => void;
}) {
  const [scenario, setScenario] = useState<Scenario>("approve");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isCard = props.method === "card";
  const profiles = isCard ? CARD_TEST_PROFILES : MOBILE_TEST_PROFILES;
  const testDigits = props.phone.replace(/\D/g, "").slice(-4);
  const forcedByPhone = !isCard && ["0001", "0002", "0003", "0004"].includes(testDigits);

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/pay/${props.orgSlug}/intents/${props.reference}/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientSecret: props.clientSecret, scenario }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message ?? "Falha na simulação.");
      props.onDone(data.status);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro inesperado.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4">
      <div className="rounded-2xl border-2 border-dashed border-warning/50 bg-warning-soft/60 p-4">
        <div className="flex items-start gap-3 text-warning">
          <FlaskConical className="mt-0.5 size-5 shrink-0" />
          <div>
            <p className="text-sm font-bold uppercase tracking-wide">Checkout simulado</p>
            <p className="text-[13px] leading-relaxed">
              Este ecrã substitui o gateway real. {isCard ? "Não introduza dados de cartão — nenhum é pedido nem aceite." : "Nenhum pedido real é enviado para o seu telemóvel."}
            </p>
          </div>
        </div>
      </div>

      <Card className="overflow-hidden">
        <div className="bg-secondary px-5 py-4 text-secondary-foreground">
          <p className="text-xs opacity-70">Valor a pagar</p>
          <p className="text-2xl font-bold tabular">{formatMzn(props.amountMinor)}</p>
          <p className="mt-1 font-mono text-[11px] opacity-70">Ref. {props.reference}</p>
        </div>
        <CardContent className="space-y-4 p-5">
          <div className="flex items-center gap-2 text-sm font-semibold">
            {isCard ? <CreditCard className="size-4" /> : <Smartphone className="size-4" />}
            {METHOD_LABELS[props.method]} — perfil de teste
          </div>

          {isCard ? (
            <div className="relative h-36 overflow-hidden rounded-xl bg-gradient-to-br from-[#161a2e] via-[#1e2f8f] to-[#2f4bd0] p-4 text-white shadow-inner">
              <div className="absolute right-3 top-3 rounded bg-white/15 px-2 py-0.5 text-[10px] font-bold tracking-widest">SIMULADO</div>
              <div className="mt-8 font-mono text-lg tracking-[0.2em] opacity-80">•••• •••• •••• TEST</div>
              <div className="mt-3 text-[11px] uppercase tracking-wider opacity-70">Cartão fictício · sem PAN · sem CVV</div>
            </div>
          ) : (
            <div className="flex items-center gap-3 rounded-xl bg-muted p-4">
              <BellRing className="size-8 text-primary" />
              <div className="text-sm">
                <p className="font-semibold">Pedido de confirmação simulado</p>
                <p className="text-muted-foreground">Seria enviado para {props.phone || "o número indicado"} num ambiente real.</p>
              </div>
            </div>
          )}

          {forcedByPhone && (
            <Alert tone="info">
              O número termina em <strong>{testDigits}</strong> — número de teste determinístico; o resultado será definido por ele.
            </Alert>
          )}

          <fieldset disabled={forcedByPhone || busy} className="space-y-2">
            <legend className="mb-2 text-xs font-medium text-muted-foreground">Escolha o resultado da simulação</legend>
            {profiles.map((p) => (
              <label
                key={p.scenario}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm transition-colors has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60",
                  scenario === p.scenario ? "border-primary bg-primary-soft/50" : "hover:bg-muted/50",
                )}
              >
                <input type="radio" name="scenario" value={p.scenario} checked={scenario === p.scenario} onChange={() => setScenario(p.scenario)} className="accent-[var(--primary)]" />
                <span>
                  <span className="block font-medium">{p.label}</span>
                  <span className="block text-xs text-muted-foreground">{p.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>

          {error && <Alert tone="danger" title={error} />}

          <Button size="lg" className="w-full" onClick={pay} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {busy ? "A processar simulação…" : `Simular pagamento de ${formatMzn(props.amountMinor)}`}
          </Button>
        </CardContent>
      </Card>
    </section>
  );
}
