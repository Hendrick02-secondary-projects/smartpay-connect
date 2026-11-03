import { cn } from "@/lib/utils";

/** SmartPay Connect mark — original artwork (two linked nodes forming an "S"). */
export function SmartPayMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-7", className)} aria-hidden>
      <rect width="32" height="32" rx="8" className="fill-secondary" />
      <path d="M21 10.5h-7.2a3.3 3.3 0 0 0 0 6.6h4.4a3.3 3.3 0 0 1 0 6.6H11" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" className="text-white dark:text-[#121013]" />
      <circle cx="21.5" cy="10.5" r="2.2" className="fill-primary" />
      <circle cx="10.5" cy="23.7" r="2.2" className="fill-primary" />
    </svg>
  );
}

export function SmartPayLogo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <SmartPayMark />
      <span className="text-[15px] font-semibold tracking-tight">
        SmartPay <span className="font-normal text-muted-foreground">Connect</span>
      </span>
    </span>
  );
}

/**
 * Tenant portal label. Text-only and driven by the organisation's configured portal
 * name, so every insurer gets its own label without code changes.
 */
export function TenantPortalMark({ name, className }: { name: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
        {name.slice(0, 1)}
      </span>
      <span className="leading-tight">
        <span className="block text-[15px] font-bold uppercase tracking-[0.08em]">{name}</span>
        <span className="block text-[11px] text-muted-foreground">via SmartPay Connect · demo</span>
      </span>
    </span>
  );
}
