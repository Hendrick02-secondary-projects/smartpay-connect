import { Banknote, BookOpenCheck, Building2, CheckCheck, FileCheck2, Landmark, Lock, ReceiptText, Scale, Wallet } from "lucide-react";
import type { LifecycleStage } from "@/lib/db/schema";
import { formatDateTime } from "@/lib/labels";
import { Badge, EmptyState } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

export interface TimelineEvent {
  id: string;
  stage: LifecycleStage;
  eventType: string;
  actorType: "user" | "system" | "public" | "provider";
  actorName: string | null;
  summary: string;
  isSimulated: boolean;
  occurredAt: Date;
}

const STAGE_META: Record<LifecycleStage, { label: string; icon: React.ReactNode; tone: string }> = {
  payment: { label: "Pagamento", icon: <Wallet />, tone: "bg-primary-soft text-primary" },
  settlement: { label: "Liquidação", icon: <Landmark />, tone: "bg-info-soft text-info" },
  reconciliation: { label: "Reconciliação", icon: <Scale />, tone: "bg-info-soft text-info" },
  kit_allocation: { label: "Alocação de Pagamentos", icon: <FileCheck2 />, tone: "bg-success-soft text-success" },
  operational_closure: { label: "Encerramento seguradora", icon: <Building2 />, tone: "bg-success-soft text-success" },
  commission_accrual: { label: "Comissão", icon: <BookOpenCheck />, tone: "bg-warning-soft text-warning" },
  commission_invoicing: { label: "Facturação", icon: <ReceiptText />, tone: "bg-warning-soft text-warning" },
  commission_collection: { label: "Cobrança", icon: <Banknote />, tone: "bg-warning-soft text-warning" },
  financial_closure: { label: "Encerramento SmartPay", icon: <Lock />, tone: "bg-secondary text-secondary-foreground" },
};

const ACTOR: Record<TimelineEvent["actorType"], string> = {
  user: "Utilizador",
  system: "Sistema",
  public: "Cliente",
  provider: "Fornecedor simulado",
};

/** Persisted lifecycle events, oldest first. Every event shows whether it is simulated. */
export function Timeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) {
    return <EmptyState icon={<CheckCheck />} title="Sem eventos" description="Os eventos aparecem aqui à medida que a transacção avança." />;
  }
  return (
    <ol className="relative space-y-4">
      {events.map((e, i) => {
        const m = STAGE_META[e.stage];
        return (
          <li key={e.id} className="relative flex gap-3">
            {i < events.length - 1 && <span aria-hidden className="absolute left-[15px] top-8 h-[calc(100%-8px)] w-px bg-border" />}
            <span className={cn("relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full [&_svg]:size-4", m.tone)}>{m.icon}</span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{m.label}</span>
                {e.isSimulated && (
                  <Badge tone="warning" className="px-1.5 py-0 text-[10px]">
                    Simulado
                  </Badge>
                )}
              </div>
              <p className="text-sm">{e.summary}</p>
              <p className="text-[11px] text-muted-foreground tabular">
                {formatDateTime(e.occurredAt)} · {e.actorName ?? ACTOR[e.actorType]}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
