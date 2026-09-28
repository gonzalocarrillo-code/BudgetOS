import { Button, Logo, Toaster, cn } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Building2, LogOut, Users, type LucideIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { clearToken } from "../lib/auth.js";
import type { Me } from "../lib/queries.js";

/**
 * The org console's frame (ADR-052, plan §3.3): superadmins manage workspaces and people here,
 * outside any workspace. Same brand and header as a workspace, its own navigation.
 */
const NAV: Array<{ to: "/org/workspaces" | "/org/people"; label: MessageKey; icon: LucideIcon; testId: string }> = [
  { to: "/org/workspaces", label: "org.nav.workspaces", icon: Building2, testId: "org-nav-workspaces" },
  { to: "/org/people", label: "org.nav.people", icon: Users, testId: "org-nav-people" },
];
const linkClass = "flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-foreground/80 transition-colors hover:bg-accent hover:text-foreground";

export function OrgShell({ me, children }: { me: Me; children: ReactNode }): ReactElement {
  const back = me.workspaces[0];
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-surface" data-testid="org-shell">
      <header className="flex h-16 shrink-0 items-center gap-4 border-b border-border bg-card px-4">
        <Link to="/" aria-label={t("shell.homeLink")}>
          <Logo size={26} />
        </Link>
        <span className="h-7 w-px bg-border" aria-hidden />
        <span className="text-sm font-semibold">{t("org.console")}</span>
        <span className="rounded-full bg-info-soft px-2.5 py-1 text-xs font-medium text-info-text">{t("role.org_admin")}</span>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden text-right text-sm lg:block">
            <span className="block font-medium">{me.user.name}</span>
            <span className="block text-[11px] text-muted-foreground">{me.user.email}</span>
          </span>
          <Button variant="ghost" size="sm" onClick={() => clearToken()}>
            <LogOut className="size-4" aria-hidden />
            {t("shell.signOut")}
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="w-60 shrink-0 overflow-y-auto border-r border-border bg-card px-3 pb-6 pt-4">
          <nav aria-label={t("org.console")} className="flex flex-col gap-0.5">
            {NAV.map((n) => {
              const Icon = n.icon;
              return (
                <Link key={n.to} to={n.to} className={linkClass} activeProps={{ className: cn(linkClass, "bg-primary font-medium text-primary-foreground hover:bg-primary hover:text-primary-foreground") }} data-testid={n.testId}>
                  <Icon className="size-4 shrink-0" aria-hidden />
                  {t(n.label)}
                </Link>
              );
            })}
            {back ? (
              <Link to="/w/$ws/home" params={{ ws: back.workspaceId }} className={cn(linkClass, "mt-4")} data-testid="org-back">
                <ArrowLeft className="size-4 shrink-0" aria-hidden />
                {t("org.back", { name: back.name })}
              </Link>
            ) : null}
          </nav>
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>
      <Toaster />
    </div>
  );
}
