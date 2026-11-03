import { Badge } from "./primitives";

type Tone = "neutral" | "success" | "warning" | "danger" | "info" | "primary";

const PAYMENT: Record<string, [string, Tone]> = {
  created: ["Criado", "neutral"],
  pending: ["Pendente", "warning"],
  successful: ["Bem-sucedido", "success"],
  failed: ["Falhado", "danger"],
  cancelled: ["Cancelado", "neutral"],
  reversed: ["Revertido", "info"],
};

const RECON_STATE: Record<string, [string, Tone]> = {
  unreconciled: ["Por reconciliar", "warning"],
  reconciled: ["Reconciliado", "success"],
  exception: ["Excepção", "danger"],
  manually_reconciled: ["Reconciliado (manual)", "info"],
};

const RECON_RECORD: Record<string, [string, Tone]> = {
  matched: ["Correspondido", "success"],
  unmatched: ["Sem correspondência", "danger"],
  amount_mismatch: ["Valor divergente", "warning"],
  duplicate_settlement: ["Liquidação duplicada", "danger"],
  under_review: ["Em revisão", "info"],
  manually_reconciled: ["Resolvido manualmente", "primary"],
  rejected: ["Rejeitado", "neutral"],
};

const LIFECYCLE: Record<string, [string, Tone]> = {
  accrued: ["Acumulada", "info"],
  adjusted: ["Ajustada", "warning"],
  invoiced: ["Facturada", "primary"],
  partially_paid: ["Parcialmente paga", "warning"],
  paid: ["Paga", "success"],
  reversed: ["Revertida", "neutral"],
  issued: ["Emitida", "primary"],
  void: ["Anulada", "neutral"],
};

const FEATURE: Record<string, [string, Tone]> = {
  simulated: ["Simulado", "warning"],
  not_verified: ["Não verificado", "neutral"],
  contractually_confirmed: ["Confirmado contratualmente", "info"],
  technically_tested: ["Testado tecnicamente", "success"],
};

const MAPS = { payment: PAYMENT, recon: RECON_STATE, record: RECON_RECORD, commission: LIFECYCLE, feature: FEATURE } as const;

export function StatusBadge({ kind, value }: { kind: keyof typeof MAPS; value: string }) {
  const [label, tone] = MAPS[kind][value] ?? [value, "neutral" as Tone];
  return (
    <Badge tone={tone} dot>
      {label}
    </Badge>
  );
}

export const PAYMENT_STATUS_LABELS = Object.fromEntries(Object.entries(PAYMENT).map(([k, v]) => [k, v[0]])) as Record<string, string>;
export const RECON_RECORD_LABELS = Object.fromEntries(Object.entries(RECON_RECORD).map(([k, v]) => [k, v[0]])) as Record<string, string>;
export const LIFECYCLE_LABELS = Object.fromEntries(Object.entries(LIFECYCLE).map(([k, v]) => [k, v[0]])) as Record<string, string>;
