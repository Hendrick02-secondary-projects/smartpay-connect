"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeftRight,
  BookOpenCheck,
  Building2,
  FileCheck2,
  MonitorPlay,
  FileSpreadsheet,
  Landmark,
  LayoutDashboard,
  Percent,
  ReceiptText,
  Scale,
} from "lucide-react";
import { cn } from "@/lib/utils";

const ICONS = {
  dashboard: LayoutDashboard,
  transactions: ArrowLeftRight,
  reconciliation: Scale,
  ledger: BookOpenCheck,
  rules: Percent,
  invoices: ReceiptText,
  settlements: Landmark,
  orgs: Building2,
  reports: FileSpreadsheet,
  kit: FileCheck2,
  demo: MonitorPlay,
} as const;

export interface NavItem {
  href: string;
  label: string;
  icon: keyof typeof ICONS;
}

export function NavLinks({ items, horizontal = false }: { items: NavItem[]; horizontal?: boolean }) {
  const pathname = usePathname();
  return (
    <nav className={cn(horizontal ? "flex gap-1 overflow-x-auto py-2" : "flex flex-col gap-0.5")}>
      {items.map((item) => {
        const Icon = ICONS[item.icon];
        const active = pathname === item.href || (item.href !== "/" && pathname.startsWith(`${item.href}/`));
        return (
          <Link
            key={item.href}
            href={item.href}
            prefetch
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm whitespace-nowrap transition-colors",
              active ? "bg-primary-soft font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
