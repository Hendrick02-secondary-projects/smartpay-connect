import { Card } from "@/components/ui/primitives";
import { Skeleton } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

export function KpiCard({
  label,
  value,
  hint,
  icon,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: React.ReactNode;
  tone?: "default" | "success" | "warning" | "danger" | "primary";
}) {
  const toneCls = {
    default: "bg-muted text-muted-foreground",
    success: "bg-success-soft text-success",
    warning: "bg-warning-soft text-warning",
    danger: "bg-danger-soft text-danger",
    primary: "bg-primary-soft text-primary",
  }[tone];
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {icon && <span className={cn("flex size-7 items-center justify-center rounded-md [&_svg]:size-3.5", toneCls)}>{icon}</span>}
      </div>
      <p className="mt-2 truncate text-[22px] font-semibold tracking-tight tabular">{value}</p>
      {hint && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{hint}</p>}
    </Card>
  );
}

export function KpiSkeletonGrid({ count = 8 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i} className="p-4">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-3 h-6 w-32" />
          <Skeleton className="mt-2 h-2.5 w-20" />
        </Card>
      ))}
    </div>
  );
}
