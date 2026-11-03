import { AlertTriangle, Check, Circle, CircleDot, Minus } from "lucide-react";
import type { Stage, StageState } from "@/lib/lifecycle/stages";
import { formatDateTime } from "@/lib/labels";
import { cn } from "@/lib/utils";

const STATE_STYLE: Record<StageState, { ring: string; icon: React.ReactNode; text: string; label: string }> = {
  done: { ring: "bg-success text-white", icon: <Check className="size-3.5" />, text: "text-foreground", label: "Concluída" },
  current: { ring: "bg-primary text-primary-foreground ring-4 ring-primary/15", icon: <CircleDot className="size-3.5" />, text: "text-foreground", label: "Em curso" },
  attention: { ring: "bg-warning text-white ring-4 ring-warning/15", icon: <AlertTriangle className="size-3.5" />, text: "text-warning", label: "Atenção" },
  pending: { ring: "bg-muted text-muted-foreground border", icon: <Circle className="size-3" />, text: "text-muted-foreground", label: "Por fazer" },
  skipped: { ring: "bg-muted text-muted-foreground/60", icon: <Minus className="size-3.5" />, text: "text-muted-foreground/70", label: "Não aplicável" },
};

/**
 * Vertical (default) or horizontal tracker of lifecycle stages. Pass only the stages
 * the audience may see (insurer: operational stages; SmartPay owner: all nine).
 */
export function StageTracker({ stages, layout = "vertical", title }: { stages: Stage[]; layout?: "vertical" | "horizontal"; title?: string }) {
  if (layout === "horizontal") {
    return (
      <div>
        {title && <p className="mb-3 text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">{title}</p>}
        <ol className="grid grid-cols-1 gap-2 sm:grid-cols-5" aria-label={title}>
          {stages.map((s, i) => {
            const st = STATE_STYLE[s.state];
            return (
              <li key={s.key} className="relative flex gap-3 rounded-lg border bg-card p-3 sm:flex-col sm:gap-2">
                <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full", st.ring)} aria-label={st.label}>
                  {st.icon}
                </span>
                <div className="min-w-0">
                  <p className={cn("text-[13px] font-semibold leading-tight", st.text)}>
                    <span className="mr-1 text-muted-foreground tabular">{i + 1}.</span>
                    {s.label}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{s.detail}</p>
                  {s.at && <p className="mt-0.5 text-[11px] text-muted-foreground tabular">{formatDateTime(s.at)}</p>}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    );
  }
  return (
    <div>
      {title && <p className="mb-3 text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">{title}</p>}
      <ol className="relative space-y-4" aria-label={title}>
        {stages.map((s, i) => {
          const st = STATE_STYLE[s.state];
          return (
            <li key={s.key} className="relative flex gap-3">
              {i < stages.length - 1 && <span aria-hidden className={cn("absolute left-3 top-7 h-[calc(100%-4px)] w-px", s.state === "done" ? "bg-success/50" : "bg-border")} />}
              <span className={cn("relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full", st.ring)} aria-label={st.label}>
                {st.icon}
              </span>
              <div className="min-w-0 pb-0.5">
                <p className={cn("text-sm font-medium leading-6", st.text)}>{s.label}</p>
                <p className="text-xs text-muted-foreground">
                  {s.detail}
                  {s.at && <span className="tabular"> · {formatDateTime(s.at)}</span>}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Compact dots for list rows. */
export function StageDots({ stages }: { stages: Stage[] }) {
  return (
    <span className="inline-flex items-center gap-1" aria-label={stages.map((s) => `${s.label}: ${STATE_STYLE[s.state].label}`).join("; ")}>
      {stages.map((s) => (
        <span
          key={s.key}
          title={`${s.label} — ${s.detail}`}
          className={cn(
            "size-2.5 rounded-full",
            s.state === "done" && "bg-success",
            s.state === "current" && "bg-primary",
            s.state === "attention" && "bg-warning",
            s.state === "pending" && "border border-muted-foreground/40 bg-transparent",
            s.state === "skipped" && "bg-muted",
          )}
        />
      ))}
    </span>
  );
}
