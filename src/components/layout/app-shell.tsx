import Link from "next/link";
import { LogOut } from "lucide-react";
import { DemoBanner } from "./demo-banner";
import { SmartPayLogo } from "./brand";
import { NavLinks, type NavItem } from "./nav-links";
import { ThemeToggle } from "./theme-toggle";
import { themeInitScript } from "./theme-script";

/** Shared, server-rendered dashboard chrome for the tenant and owner areas. */
export function AppShell({
  area,
  areaLabel,
  nav,
  user,
  logoutTo,
  children,
}: {
  area: string;
  areaLabel: string;
  nav: NavItem[];
  user: { name: string; email: string; roleLabel: string };
  logoutTo: "tenant" | "owner";
  children: React.ReactNode;
}) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      <DemoBanner />
      <div className="flex min-h-[calc(100dvh-30px)]">
        <aside className="sticky top-[30px] hidden h-[calc(100dvh-30px)] w-60 shrink-0 flex-col border-r bg-sidebar lg:flex">
          <div className="px-5 py-5">
            <Link href={nav[0]?.href ?? "/"}>
              <SmartPayLogo />
            </Link>
            <p className="mt-3 rounded-md bg-primary-soft px-2 py-1 text-[11px] font-semibold text-primary">{area}</p>
          </div>
          <div className="flex-1 px-3">
            <p className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{areaLabel}</p>
            <NavLinks items={nav} />
          </div>
          <div className="border-t p-4">
            <div className="flex items-center gap-3">
              <span className="flex size-8 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground">
                {user.name.split(" ").map((p) => p[0]).slice(0, 2).join("")}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{user.name}</p>
                <p className="truncate text-[11px] text-muted-foreground">{user.roleLabel}</p>
              </div>
            </div>
            <div className="mt-3 flex items-center gap-1">
              <ThemeToggle />
              <form action="/api/auth/logout" method="post" className="flex-1">
                <input type="hidden" name="to" value={logoutTo} />
                <button type="submit" className="flex h-9 w-full items-center justify-center gap-2 rounded-md text-sm text-muted-foreground hover:bg-muted hover:text-foreground">
                  <LogOut className="size-4" /> Sair
                </button>
              </form>
            </div>
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-[30px] z-30 flex items-center justify-between border-b bg-card/90 px-4 py-3 backdrop-blur lg:hidden">
            <SmartPayLogo />
            <div className="flex items-center gap-1">
              <ThemeToggle />
              <form action="/api/auth/logout" method="post">
                <input type="hidden" name="to" value={logoutTo} />
                <button type="submit" aria-label="Sair" className="flex size-9 items-center justify-center rounded-md hover:bg-muted">
                  <LogOut className="size-4" />
                </button>
              </form>
            </div>
          </header>
          <div className="border-b bg-card px-2 lg:hidden">
            <NavLinks items={nav} horizontal />
          </div>
          <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
        </div>
      </div>
    </>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
