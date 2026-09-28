import { Button, cn } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Bell,
  BookOpen,
  ChartColumn,
  CircleCheck,
  Database,
  FlaskConical,
  Gauge,
  House,
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
  CalendarRange,
  MessageSquare,
  Building2,
  Settings,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState, type ReactElement, type ReactNode } from "react";
import { GlobalSearch, useSearchHotkeys } from "../features/search/global-search.js";
import { TourLauncher } from "../features/home/tour-launcher.js";
import { clearToken } from "../lib/auth.js";
import { api, unwrap } from "../lib/api.js";
import { registryQuery, type Me } from "../lib/queries.js";

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
  { to: "/w/$ws/home", label: "nav.home", icon: House, tour: "nav-home" },
  { to: "/w/$ws", label: "nav.overview", icon: LayoutDashboard, tour: "nav-overview" },
  { to: "/w/$ws/budgets", label: "nav.budgets", icon: ChartColumn, tour: "nav-budgets" },
  { to: "/w/$ws/approvals", label: "nav.approvals", icon: CircleCheck, tour: "nav-approvals" },
  { to: "/w/$ws/targets", label: "nav.targets", icon: Target, tour: "nav-targets" },
  { to: "/w/$ws/experiments", label: "nav.experiments", icon: FlaskConical, tour: "nav-experiments" },
  { to: "/w/$ws/alerts", label: "nav.alerts", icon: Bell, tour: "nav-alerts" },
  { to: "/w/$ws/closures", label: "nav.closures", icon: Lock, tour: "nav-closures" },
  { to: "/w/$ws/sources", label: "nav.sources", icon: Database, tour: "nav-sources" },
];
// The admin pages people use day to day stay in the sidebar; the rest live under Settings
// (product feedback 2026-09-28).
const ADMIN: NavItem[] = [
  { to: "/w/$ws/admin/registry", label: "admin.registry", icon: BookOpen },
  { to: "/w/$ws/admin/rules", label: "admin.rules", icon: Gauge },
  { to: "/w/$ws/admin/roles", label: "admin.roles", icon: Users },
  { to: "/w/$ws/admin/tags", label: "admin.tags", icon: Tag },
];

/** Settings: its own page (the hub) and a strip above each of these pages to move between them. */
export const SETTINGS_PAGES: Array<NavItem & { description: MessageKey }> = [
  { to: "/w/$ws/admin/workspace", label: "admin.workspace", icon: Building2, description: "settings.desc.workspace" },
  { to: "/w/$ws/admin/policies", label: "admin.policies", icon: ShieldCheck, description: "settings.desc.policies" },
  { to: "/w/$ws/admin/slack", label: "admin.slack", icon: MessageSquare, description: "settings.desc.slack" },
  { to: "/w/$ws/admin/sources", label: "admin.sources", icon: Plug, description: "settings.desc.sources" },
  { to: "/w/$ws/admin/naming", label: "admin.naming", icon: Type, description: "settings.desc.naming" },
  { to: "/w/$ws/admin/periods", label: "admin.periods", icon: CalendarRange, description: "settings.desc.periods" },
  { to: "/w/$ws/admin/templates", label: "admin.templates", icon: LayoutTemplate, description: "settings.desc.templates" },
  { to: "/w/$ws/admin/tours", label: "admin.tours", icon: Map, description: "settings.desc.tours" },
];
const SETTINGS_HUB = "/w/$ws/admin/settings";
const settingsPath = (pathname: string, ws: string) => [SETTINGS_HUB, ...SETTINGS_PAGES.map((p) => p.to)].some((to) => pathname === to.replace("$ws", ws));

function SettingsStrip({ ws }: { ws: string }): ReactElement {
  return (
    <nav aria-label={t("admin.settings")} className="flex gap-1 overflow-x-auto border-b border-border bg-card px-6" data-testid="settings-strip">
      <Link to={SETTINGS_HUB} params={{ ws }} activeOptions={{ exact: true }} className="whitespace-nowrap border-b-2 border-transparent px-2 py-2.5 text-sm text-muted-foreground hover:text-foreground" activeProps={{ className: "whitespace-nowrap border-b-2 border-primary px-2 py-2.5 text-sm font-medium text-foreground" }}>
        {t("admin.settings")}
      </Link>
      {SETTINGS_PAGES.map((p) => (
        <Link key={p.to} to={p.to} params={{ ws }} className="whitespace-nowrap border-b-2 border-transparent px-2 py-2.5 text-sm text-muted-foreground hover:text-foreground" activeProps={{ className: "whitespace-nowrap border-b-2 border-primary px-2 py-2.5 text-sm font-medium text-foreground" }}>
          {t(p.label)}
        </Link>
      ))}
    </nav>
  );
}

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
  const [searching, setSearching] = useState(false);
  const openSearch = useCallback(() => setSearching(true), []);
  useSearchHotkeys(openSearch);
  const { data: dimensions = [] } = useQuery(registryQuery(ws));
  const current = me.workspaces.find((w) => w.workspaceId === ws);
  const pathname = useRouterState({ select: (st) => st.location.pathname });
  const inSettings = settingsPath(pathname, ws);
  return (
    <div className="flex min-h-screen flex-col bg-surface">
      <header className="flex h-16 shrink-0 items-center gap-4 border-b border-border bg-card px-4">
        <label className="flex h-10 w-40 shrink-0 items-center gap-2 rounded-lg border border-border bg-card px-3 shadow-xs lg:w-60" data-tour="workspace-switcher">
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
        <button
          type="button"
          onClick={openSearch}
          className="flex h-10 min-w-0 max-w-xl flex-1 items-center gap-2 rounded-full border border-border bg-muted/60 px-4 text-left text-sm text-muted-foreground hover:border-input"
          data-tour="global-search"
          data-testid="global-search"
          aria-label={t("search.palette")}
        >
          <Search className="size-4 shrink-0" aria-hidden />
          <span className="flex-1 truncate">{t("shell.search.placeholder")}</span>
          <kbd className="rounded border border-border bg-card px-1.5 text-[11px]">{t("search.shortcut")}</kbd>
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <TourLauncher ws={ws} />
          <Profile ws={ws} name={me.user.name} email={me.user.email} />
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
            <Link to={SETTINGS_HUB} params={{ ws }} className={cn(linkClass, inSettings && activeClass)} data-testid="nav-settings" aria-current={inSettings ? "page" : undefined}>
              <Settings className="size-4 shrink-0" aria-hidden />
              {t("admin.settings")}
            </Link>
          </nav>
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto">
          {inSettings ? <SettingsStrip ws={ws} /> : null}
          {children}
        </main>
      </div>
      <GlobalSearch ws={ws} dimensions={dimensions} open={searching} onOpenChange={setSearching} />
      <div role="status" aria-live="polite" className="sr-only" data-testid="toasts" />
    </div>
  );
}

/** The signed-in person: their name (editable; what Home greets them by) and email. */
function Profile({ ws, name, email }: { ws: string; name: string; email: string }): ReactElement {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async (n: string) => unwrap(api.PATCH("/api/v1/me", { params: { header: { "X-Workspace-Id": ws } }, body: { name: n } as never })),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["me"] });
      setOpen(false);
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });
  return (
    <div className="relative">
      <button type="button" className="flex max-w-64 flex-col items-end rounded-md px-2 py-0.5 text-right hover:bg-accent" onClick={() => (setDraft(name), setError(null), setOpen((v) => !v))} aria-expanded={open} data-testid="profile-button">
        <span className="max-w-60 truncate text-sm font-medium" data-testid="user-name">{name}</span>
        <span className="hidden max-w-60 truncate text-[11px] text-muted-foreground lg:inline" data-testid="user-email">{email}</span>
      </button>
      {open ? (
        <form
          className="absolute right-0 top-12 z-40 flex w-72 flex-col gap-2 rounded-xl border border-border bg-card p-3 shadow-lg"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) save.mutate(draft.trim());
          }}
          data-testid="profile-form"
        >
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t("profile.edit")}
            <input className="h-9 rounded-md border border-input bg-card px-2.5 text-sm font-normal" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus data-testid="profile-name" />
          </label>
          <p className="text-xs text-muted-foreground">{t("profile.help")}</p>
          {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>{t("profile.cancel")}</Button>
            {draft.trim() && !save.isPending ? (
              <Button type="submit" size="sm" data-testid="profile-save">{t("profile.save")}</Button>
            ) : (
              <Button type="button" size="sm" disabled reason={save.isPending ? t("shell.loading") : t("profile.needName")}>{t("profile.save")}</Button>
            )}
          </div>
        </form>
      ) : null}
    </div>
  );
}
