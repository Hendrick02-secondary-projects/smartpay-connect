"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Re-renders the current server page every `intervalMs` while the tab is visible,
 * so a second device sees changes made on another one (3-device demo). Data always
 * comes from PostgreSQL; nothing is kept in the browser. Can be paused.
 */
export function AutoRefresh({ intervalMs = 8000, label = "Actualização automática" }: { intervalMs?: number; label?: string }) {
  const router = useRouter();
  const [on, setOn] = useState(true);
  const [last, setLast] = useState<Date | null>(null);

  useEffect(() => {
    if (!on) return;
    const tick = () => {
      if (document.visibilityState === "visible") {
        router.refresh();
        setLast(new Date());
      }
    };
    const id = window.setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [on, intervalMs, router]);

  return (
    <button
      type="button"
      onClick={() => setOn((v) => !v)}
      aria-pressed={on}
      className="no-print inline-flex items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted"
      title={last ? `Última actualização: ${last.toLocaleTimeString("pt-MZ")}` : undefined}
    >
      <RefreshCw className={cn("size-3.5", on && "animate-[spin_3s_linear_infinite] text-success")} />
      {label}: {on ? "ligada" : "pausada"}
    </button>
  );
}
