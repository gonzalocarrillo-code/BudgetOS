import { Button, cn } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Bell,
  BookOpen,
  ChartColumn,
  CircleCheck,
  Database,
  FlaskConical,
  Gauge,
  LayoutDashboard,
  LayoutTemplate,
  Lock,
  LogOut,
  Map,
  Plug,
  Search,
  ShieldCheck,
  Tag,
  Target,
  Type,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useState, type FormEvent, type ReactElement, type ReactNode } from "react";
import { clearToken } from "../lib/auth.js";
import type { Me } from "../lib/queries.js";

/**
 * The app shell (spec §18.1 __root, ADR-021): a white top bar with the workspace switcher and the
 * search entry, a white sidebar with icon navigation (the active item is solid primary), and the
 * content on the surface colour.
 */

interface NavItem {
  to: string;
  label: MessageKey;
  icon: LucideIcon;
  tour?: string;
}
const NAV: NavItem[] = [
  { to: "/w/$ws", label: "nav.overview", icon: LayoutDashboard, tour: "nav-overview" },
  { to: "/w/$ws/budgets", label: "nav.budgets", icon: ChartColumn, tour: "nav-budgets" },
  { to: "/w/$ws/approvals", label: "nav.approvals", icon: CircleCheck, tour: "nav-approvals" },
  { to: "/w/$ws/targets", label: "nav.targets", icon: Target, tour: "nav-targets" },
  { to: "/w/$ws/experiments", label: "nav.experiments", icon: FlaskConical, tour: "nav-experiments" },
  { to: "/w/$ws/alerts", label: "nav.alerts", icon: Bell, tour: "nav-alerts" },
  { to: "/w/$ws/closures", label: "nav.closures", icon: Lock, tour: "nav-closures" },
  { to: "/w/$ws/sources", label: "nav.sources", icon: Database, tour: "nav-sources" },
];
const ADMIN: NavItem[] = [
  { to: "/w/$ws/admin/registry", label: "admin.registry", icon: BookOpen },
  { to: "/w/$ws/admin/policies", label: "admin.policies", icon: ShieldCheck },
  { to: "/w/$ws/admin/rules", label: "admin.rules", icon: Gauge },
  { to: "/w/$ws/admin/roles", label: "admin.roles", icon: Users },
  { to: "/w/$ws/admin/tags", label: "admin.tags", icon: Tag },
  { to: "/w/$ws/admin/sources", label: "admin.sources", icon: Plug },
  { to: "/w/$ws/admin/naming", label: "admin.naming", icon: Type },
  { to: "/w/$ws/admin/templates", label: "admin.templates", icon: LayoutTemplate },
  { to: "/w/$ws/admin/tours", label: "admin.tours", icon: Map },
];

const linkClass = "flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-foreground/80 transition-colors hover:bg-accent hover:text-foreground";
const activeClass = "bg-primary font-medium text-primary-foreground hover:bg-primary hover:text-primary-foreground";

function NavLink({ item, ws, exact = false }: { item: NavItem; ws: string; exact?: boolean }): ReactElement {
  const Icon = item.icon;
  return (
    <Link to={item.to} params={{ ws }} activeOptions={{ exact }} className={linkClass} activeProps={{ className: cn(linkClass, activeClass) }} data-tour={item.tour}>
      <Icon className="size-4 shrink-0" aria-hidden />
      {t(item.label)}
    </Link>
  );
}

const SectionLabel = ({ children }: { children: ReactNode }) => <div className="px-3 pb-1 pt-5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{children}</div>;

export function Shell({ me, ws, children }: { me: Me; ws: string; children: ReactNode }): ReactElement {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const current = me.workspaces.find((w) => w.workspaceId === ws);
  const search = (e: FormEvent) => {
    e.preventDefault();
    void navigate({ to: "/w/$ws/search", params: { ws }, search: { q } });
  };
  return (
    <div className="flex min-h-screen flex-col bg-surface">
      <header className="flex h-16 shrink-0 items-center gap-4 border-b border-border bg-card px-4">
        <label className="flex h-10 w-60 items-center gap-2 rounded-lg border border-border bg-card px-3 shadow-xs" data-tour="workspace-switcher">
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground" aria-hidden>
            {(current?.name ?? "?").slice(0, 1).toUpperCase()}
          </span>
          <span className="sr-only">{t("shell.workspace")}</span>
          <select
            className="min-w-0 flex-1 cursor-pointer appearance-none truncate bg-transparent text-sm font-medium text-foreground outline-none"
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
        <form onSubmit={search} className="flex max-w-xl flex-1 items-center gap-2 rounded-full border border-border bg-muted/60 px-4 focus-within:border-ring focus-within:bg-card" role="search" data-tour="global-search">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input className="h-10 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" placeholder={t("shell.search.placeholder")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("nav.search")} data-testid="global-search" />
          <button type="submit" className="sr-only">
            {t("shell.search.submit")}
          </button>
        </form>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-sm text-muted-foreground" data-testid="user-email">
            {me.user.email}
          </span>
          <Button variant="ghost" size="sm" onClick={() => clearToken()}>
            <LogOut className="size-4" aria-hidden />
            {t("shell.signOut")}
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="w-60 shrink-0 overflow-y-auto border-r border-border bg-card px-3 pb-6">
          <nav aria-label={t("shell.navigation")} className="flex flex-col gap-0.5">
            <SectionLabel>{t("shell.workspace")}</SectionLabel>
            {NAV.map((item) => (
              <NavLink key={item.to} item={item} ws={ws} exact={item.to === "/w/$ws"} />
            ))}
            <SectionLabel>{t("shell.admin")}</SectionLabel>
            {ADMIN.map((item) => (
              <NavLink key={item.to} item={item} ws={ws} />
            ))}
          </nav>
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>
      <div role="status" aria-live="polite" className="sr-only" data-testid="toasts" />
    </div>
  );
}
