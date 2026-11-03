import { KpiSkeletonGrid } from "@/components/dashboard/kpi-card";
import { Card, Skeleton } from "@/components/ui/primitives";

export default function Loading() {
  return (
    <div aria-busy="true" aria-label="A carregar painel">
      <Skeleton className="mb-2 h-7 w-48" />
      <Skeleton className="mb-6 h-4 w-72" />
      <KpiSkeletonGrid />
      <div className="mt-6 grid gap-4 xl:grid-cols-3">
        <Card className="p-5 xl:col-span-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-6 h-56 w-full" />
        </Card>
        <Card className="p-5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mx-auto mt-6 size-40 rounded-full" />
        </Card>
      </div>
    </div>
  );
}
