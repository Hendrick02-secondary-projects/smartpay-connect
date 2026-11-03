import { FlaskConical } from "lucide-react";
import { cn } from "@/lib/utils";

/** Always-visible indicator that nothing on this site moves real money. */
export function DemoBanner({ className }: { className?: string }) {
  return (
    <div
      role="note"
      aria-label="Ambiente de demonstração"
      className={cn(
        "no-print sticky top-0 z-50 flex items-center justify-center gap-2 bg-[repeating-linear-gradient(135deg,#171a20_0_12px,#20242c_12px_24px)] px-3 py-1.5 text-center text-[11px] font-semibold uppercase tracking-[0.12em] text-amber-200",
        className,
      )}
    >
      <FlaskConical className="size-3.5" aria-hidden />
      <span>Demo · Pagamentos simulados — nenhum dinheiro real é processado</span>
    </div>
  );
}
