import { Button, cn } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent, type ReactElement, type ReactNode } from "react";
import { clearToken } from "../lib/auth.js";
import type { Me } from "../lib/queries.js";

/** The app shell (spec §18.1 __root): navigation, workspace switcher and the search entry. */

const NAV: Array<{ to: string; label: MessageKey; tour: string }> = [
  { to: "/w/$ws", label: "nav.overview", tour: "nav-overview" },
  { to: "/w/$ws/budgets", label: "nav.budgets", tour: "nav-budgets" },
  { to: "/w/$ws/approvals", label: "nav.approvals", tour: "nav-approvals" },
  { to: "/w/$ws/targets", label: "nav.targets", tour: "nav-targets" },
  { to: "/w/$ws/experiments", label: "nav.experiments", tour: "nav-experiments" },
  { to: "/w/$ws/alerts", label: "nav.alerts", tour: "nav-alerts" },
  { to: "/w/$ws/closures", label: "nav.closures", tour: "nav-closures" },
  { to: "/w/$ws/sources", label: "nav.sources", tour: "nav-sources" },
];
const ADMIN: Array<{ to: string; label: MessageKey }> = [
  { to: "/w/$ws/admin/registry", label: "admin.registry" },
  { to: "/w/$ws/admin/policies", label: "admin.policies" },
  { to: "/w/$ws/admin/rules", label: "admin.rules" },
  { to: "/w/$ws/admin/roles", label: "admin.roles" },
  { to: "/w/$ws/admin/tags", label: "admin.tags" },
  { to: "/w/$ws/admin/sources", label: "admin.sources" },
  { to: "/w/$ws/admin/naming", label: "admin.naming" },
  { to: "/w/$ws/admin/templates", label: "admin.templates" },
  { to: "/w/$ws/admin/tours", label: "admin.tours" },
];

const linkClass = "block rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground";
const activeClass = "bg-accent font-medium text-accent-foreground";

export function Shell({ me, ws, children }: { me: Me; ws: string; children: ReactNode }): ReactElement {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const search = (e: FormEvent) => {
    e.preventDefault();
    void navigate({ to: "/w/$ws/search", params: { ws }, search: { q } });
  };
  return (
    <div className="grid min-h-screen grid-cols-[14rem_1fr]">
      <aside className="flex flex-col gap-4 border-r border-border p-3">
        <div className="px-3 pt-2 text-sm font-semibold">{t("app.name")}</div>
        <label className="flex flex-col gap-1 px-3 text-xs text-muted-foreground" data-tour="workspace-switcher">
          {t("shell.workspace")}
          <select
            className="rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground"
            value={ws}
            data-testid="workspace-switcher"
            onChange={(e) => void navigate({ to: "/w/$ws", params: { ws: e.target.value } })}
          >
            {me.workspaces.map((w) => (
              <option key={w.workspaceId} value={w.workspaceId}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <nav aria-label={t("shell.navigation")} className="flex flex-col gap-0.5">
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} params={{ ws }} activeOptions={{ exact: n.to === "/w/$ws" }} className={linkClass} activeProps={{ className: cn(linkClass, activeClass) }} data-tour={n.tour}>
              {t(n.label)}
            </Link>
          ))}
          <div className="px-3 pb-1 pt-4 text-xs font-medium uppercase text-muted-foreground">{t("shell.admin")}</div>
          {ADMIN.map((n) => (
            <Link key={n.to} to={n.to} params={{ ws }} className={linkClass} activeProps={{ className: cn(linkClass, activeClass) }}>
              {t(n.label)}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-col">
        <header className="flex items-center gap-3 border-b border-border px-6 py-3">
          <form onSubmit={search} className="flex flex-1 gap-2" role="search" data-tour="global-search">
            <input className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm" placeholder={t("shell.search.placeholder")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("nav.search")} data-testid="global-search" />
            <Button type="submit" variant="outline">
              {t("shell.search.submit")}
            </Button>
          </form>
          <span className="text-sm text-muted-foreground" data-testid="user-email">
            {me.user.email}
          </span>
          <Button variant="ghost" onClick={() => clearToken()}>
            {t("shell.signOut")}
          </Button>
        </header>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
      <div role="status" aria-live="polite" className="sr-only" data-testid="toasts" />
    </div>
  );
}
