import { Avatar, Button, Dialog, DialogContent, FormField, Input, Kbd, Logo, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Popover, PopoverContent, PopoverTrigger, Toaster, cn } from "@budget/ui";
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
  Archive,
  Menu as MenuIcon,
  Monitor,
  Moon,
  Sun,
  Camera,
  Check,
  ChevronDown,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from "react";
import { GlobalSearch, useSearchHotkeys } from "../features/search/global-search.js";
import { TourLauncher } from "../features/home/tour-launcher.js";
import { NotificationBell } from "../features/home/notifications.js";
import { clearToken } from "../lib/auth.js";
import { api, unwrap } from "../lib/api.js";
import { registryQuery, type Me } from "../lib/queries.js";
import { setThemeChoice, useTheme, type ThemeChoice } from "../lib/theme.js";
import type { Action } from "@budget/domain";

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
  /**
   * UX-003: shown when the caller's roles here grant any of these actions ("org" = org admin only).
   * No list: every member (the page is read-only for those who cannot change it).
   */
  requires?: Array<Action | "org">;
}

/** Whether the signed-in person sees a nav item or settings page in this workspace (UX-003). */
export function canSee(item: Pick<NavItem, "requires">, me: Me, ws: string): boolean {
  if (!item.requires || me.isOrgAdmin) return true;
  const perms = me.workspaces.find((w) => w.workspaceId === ws)?.permissions ?? [];
  return item.requires.some((r) => r !== "org" && perms.includes(r));
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
  { to: "/w/$ws/snapshots", label: "nav.snapshots", icon: Camera, tour: "nav-snapshots" },
  { to: "/w/$ws/sources", label: "nav.sources", icon: Database, tour: "nav-sources" },
];
// The admin pages people use day to day stay in the sidebar; the rest live under Settings
// (product feedback 2026-09-28).
const ADMIN: NavItem[] = [
  { to: "/w/$ws/admin/registry", label: "admin.registry", icon: BookOpen },
  { to: "/w/$ws/admin/rules", label: "admin.rules", icon: Gauge },
  { to: "/w/$ws/admin/roles", label: "admin.roles", icon: Users, requires: ["user.manage"] },
  { to: "/w/$ws/admin/tags", label: "admin.tags", icon: Tag },
];

/** Settings: its own page (the hub) and a strip above each of these pages to move between them. */
/** The sidebar's admin pages, as Settings hub cards. */
const ADMIN_SETTINGS: Array<NavItem & { description: MessageKey }> = [
  { to: "/w/$ws/admin/registry", label: "admin.registry", icon: BookOpen, description: "settings.desc.registry" },
  { to: "/w/$ws/admin/rules", label: "admin.rules", icon: Gauge, description: "settings.desc.rules" },
  { to: "/w/$ws/admin/roles", label: "admin.roles", icon: Users, requires: ["user.manage"], description: "settings.desc.roles" },
  { to: "/w/$ws/admin/tags", label: "admin.tags", icon: Tag, description: "settings.desc.tags" },
];

export const SETTINGS_PAGES: Array<NavItem & { description: MessageKey }> = [
  { to: "/w/$ws/admin/workspace", label: "admin.workspace", icon: Building2, requires: ["user.manage"], description: "settings.desc.workspace" },
  { to: "/w/$ws/admin/policies", label: "admin.policies", icon: ShieldCheck, requires: ["policy.manage", "approval.decide"], description: "settings.desc.policies" },
  { to: "/w/$ws/admin/slack", label: "admin.slack", icon: MessageSquare, requires: ["user.manage"], description: "settings.desc.slack" },
  { to: "/w/$ws/admin/sources", label: "admin.sources", icon: Plug, requires: ["source.manage"], description: "settings.desc.sources" },
  { to: "/w/$ws/admin/naming", label: "admin.naming", icon: Type, requires: ["registry.manage"], description: "settings.desc.naming" },
  { to: "/w/$ws/admin/periods", label: "admin.periods", icon: CalendarRange, requires: ["registry.manage", "closure.close", "closure.restate"], description: "settings.desc.periods" },
  { to: "/w/$ws/admin/templates", label: "admin.templates", icon: LayoutTemplate, requires: ["user.manage"], description: "settings.desc.templates" },
  { to: "/w/$ws/admin/tours", label: "admin.tours", icon: Map, requires: ["user.manage"], description: "settings.desc.tours" },
];
const SETTINGS_HUB = "/w/$ws/admin/settings";

/**
 * UX-009 (plan §11.6): the Settings hub groups every admin page by what it is for, the sidebar's
 * day-to-day pages included, so there is one place to find a setting.
 */
export type SettingsGroup = "workspace" | "people" | "taxonomy" | "pacing" | "data" | "onboarding";
export const SETTINGS_GROUPS: Array<{ id: SettingsGroup; label: MessageKey; pages: Array<NavItem & { description: MessageKey }> }> = [];
const byPath = (to: string) => [...SETTINGS_PAGES, ...ADMIN_SETTINGS].find((p) => p.to === to) as NavItem & { description: MessageKey };
SETTINGS_GROUPS.push(
  { id: "workspace", label: "settings.group.workspace", pages: [byPath("/w/$ws/admin/workspace"), byPath("/w/$ws/admin/periods"), byPath("/w/$ws/admin/templates")] },
  { id: "people", label: "settings.group.people", pages: [byPath("/w/$ws/admin/roles"), byPath("/w/$ws/admin/policies")] },
  { id: "taxonomy", label: "settings.group.taxonomy", pages: [byPath("/w/$ws/admin/registry"), byPath("/w/$ws/admin/tags"), byPath("/w/$ws/admin/naming")] },
  { id: "pacing", label: "settings.group.pacing", pages: [byPath("/w/$ws/admin/rules")] },
  { id: "data", label: "settings.group.data", pages: [byPath("/w/$ws/admin/sources"), byPath("/w/$ws/admin/slack")] },
  { id: "onboarding", label: "settings.group.onboarding", pages: [byPath("/w/$ws/admin/tours")] },
);
const settingsPath = (pathname: string, ws: string) => [SETTINGS_HUB, ...SETTINGS_PAGES.map((p) => p.to)].some((to) => pathname === to.replace("$ws", ws));

function SettingsStrip({ ws, me }: { ws: string; me: Me }): ReactElement {
  return (
    <nav aria-label={t("admin.settings")} className="flex gap-1 overflow-x-auto border-b border-border bg-card px-6" data-testid="settings-strip">
      <Link to={SETTINGS_HUB} params={{ ws }} activeOptions={{ exact: true }} className="whitespace-nowrap border-b-2 border-transparent px-2 py-2.5 text-sm text-muted-foreground hover:text-foreground" activeProps={{ className: "whitespace-nowrap border-b-2 border-primary px-2 py-2.5 text-sm font-medium text-foreground" }}>
        {t("admin.settings")}
      </Link>
      {SETTINGS_PAGES.filter((p) => canSee(p, me, ws)).map((p) => (
        <Link key={p.to} to={p.to} params={{ ws }} className="whitespace-nowrap border-b-2 border-transparent px-2 py-2.5 text-sm text-muted-foreground hover:text-foreground" activeProps={{ className: "whitespace-nowrap border-b-2 border-primary px-2 py-2.5 text-sm font-medium text-foreground" }}>
          {t(p.label)}
        </Link>
      ))}
    </nav>
  );
}

const linkClass = "flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-foreground/80 transition-colors hover:bg-accent hover:text-foreground md:max-xl:justify-center md:max-xl:px-0";
const activeClass = "bg-primary font-medium text-primary-foreground hover:bg-primary hover:text-primary-foreground";

function NavLink({ item, ws, exact = false }: { item: NavItem; ws: string; exact?: boolean }): ReactElement {
  const Icon = item.icon;
  return (
    <Link to={item.to} params={{ ws }} activeOptions={{ exact }} title={t(item.label)} className={linkClass} activeProps={{ className: cn(linkClass, activeClass) }} data-tour={item.tour}>
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className={labelClass}>{t(item.label)}</span>
    </Link>
  );
}

/** In the icon rail (768–1279 px) labels are hidden but still read by screen readers. */
const labelClass = "md:max-xl:sr-only";
const SectionLabel = ({ children }: { children: ReactNode }) => (
  <div className="px-3 pb-1 pt-5 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground md:max-xl:px-0 md:max-xl:pt-3">
    <span className="md:max-xl:sr-only">{children}</span>
    <span className="hidden h-px bg-border md:max-xl:block" aria-hidden />
  </div>
);

export function Shell({ me, ws, children }: { me: Me; ws: string; children: ReactNode }): ReactElement {
  const navigate = useNavigate();
  const [searching, setSearching] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const openSearch = useCallback(() => setSearching(true), []);
  useSearchHotkeys(openSearch);
  useShortcuts(ws, () => setShortcuts(true));
  const { data: dimensions = [] } = useQuery(registryQuery(ws));
  const archived = me.archivedWorkspaces.find((w) => w.workspaceId === ws);
  const current = me.workspaces.find((w) => w.workspaceId === ws) ?? (archived ? { workspaceId: archived.workspaceId, name: archived.name, roles: ["ORG_ADMIN"] } : undefined);
  // ADR-052: a superadmin here through the org-wide role only (no role of their own in this workspace).
  const shownWorkspace = current?.name ?? me.archivedWorkspaces.find((w) => w.workspaceId === ws)?.name ?? "?";
  const asSuperadmin = me.isOrgAdmin && (current?.roles ?? []).every((r) => r === "ORG_ADMIN");
  const pathname = useRouterState({ select: (st) => st.location.pathname });
  const inSettings = settingsPath(pathname, ws);
  useDocumentTitle(pathname, ws, current?.name);
  // A phone's navigation panel closes once a page is chosen.
  useEffect(() => setNavOpen(false), [pathname]);
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-surface">
      <header className="flex h-16 shrink-0 items-center gap-2 border-b border-border bg-card px-3 md:gap-4 md:px-4">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setNavOpen(true)} aria-label={t("nav.open")} aria-expanded={navOpen} data-testid="nav-open">
          <MenuIcon className="size-5" aria-hidden />
        </Button>
        <Link to="/w/$ws/home" params={{ ws }} className="flex shrink-0 items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={t("shell.homeLink")} data-testid="brand">
          <Logo size={26} className="hidden lg:inline-flex" />
          <Logo variant="mark" size={28} className="lg:hidden" />
        </Link>
        <span className="hidden h-7 w-px shrink-0 bg-border lg:block" aria-hidden />
        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              className="flex h-10 w-36 min-w-0 shrink items-center gap-2 rounded-lg border border-border bg-card px-2.5 text-sm shadow-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:w-48 lg:w-60"
              aria-label={t("shell.workspace")}
              data-testid="workspace-switcher"
              data-value={ws}
              data-tour="workspace-switcher"
            >
              <span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary text-xs font-semibold text-primary-foreground" aria-hidden>
                {shownWorkspace.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 truncate text-left font-medium text-foreground">{shownWorkspace}</span>
              <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            </button>
          </MenuTrigger>
          <MenuContent align="start" className="w-72" data-testid="workspace-menu">
            <MenuLabel>{t("shell.workspace")}</MenuLabel>
            {me.workspaces.map((w) => (
              <MenuItem key={w.workspaceId} onSelect={() => void navigate({ to: "/w/$ws", params: { ws: w.workspaceId } })} className="items-center gap-2" data-testid="workspace-option" data-value={w.workspaceId}>
                <span className="grid size-6 shrink-0 place-items-center rounded-md bg-secondary text-xs font-semibold text-foreground" aria-hidden>
                  {w.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate">{w.name}</span>
                {w.workspaceId === ws ? <Check className="size-4 shrink-0 text-primary" aria-label={t("shell.currentWorkspace")} /> : null}
              </MenuItem>
            ))}
            {me.archivedWorkspaces.length > 0 ? (
              <>
                <MenuSeparator />
                <MenuLabel>{t("shell.archived")}</MenuLabel>
                {me.archivedWorkspaces.map((w) => (
                  <MenuItem key={w.workspaceId} onSelect={() => void navigate({ to: "/w/$ws", params: { ws: w.workspaceId } })} className="items-center gap-2 text-muted-foreground" data-testid="workspace-option" data-value={w.workspaceId}>
                    <Archive className="size-4 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{w.name}</span>
                    {w.workspaceId === ws ? <Check className="size-4 shrink-0 text-primary" aria-label={t("shell.currentWorkspace")} /> : null}
                  </MenuItem>
                ))}
              </>
            ) : null}
            {me.isOrgAdmin ? (
              <>
                <MenuSeparator />
                <MenuItem onSelect={() => void navigate({ to: "/org/workspaces" })} className="items-center gap-2" data-testid="workspace-manage">
                  <Building2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  {t("shell.manageWorkspaces")}
                </MenuItem>
              </>
            ) : null}
          </MenuContent>
        </Menu>
        {asSuperadmin ? (
          <span className="hidden shrink-0 items-center gap-1 rounded-full bg-info-soft px-2.5 py-1 text-xs font-medium text-info-text xl:inline-flex" title={t("shell.superadminHint")} data-testid="superadmin-badge">
            <ShieldCheck className="size-3.5" aria-hidden />
            {t("role.org_admin")}
          </span>
        ) : null}
        <button
          type="button"
          onClick={openSearch}
          className="flex h-10 min-w-10 max-w-xl flex-1 items-center gap-2 rounded-full border border-border bg-muted/60 px-3 text-left text-sm text-muted-foreground hover:border-input md:px-4"
          data-tour="global-search"
          data-testid="global-search"
          aria-label={t("search.palette")}
        >
          <Search className="size-4 shrink-0" aria-hidden />
          <span className="hidden flex-1 truncate sm:inline">{t("shell.search.placeholder")}</span>
          <Kbd className="hidden md:inline-flex">{t("search.shortcut")}</Kbd>
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <TourLauncher ws={ws} onShortcuts={() => setShortcuts(true)} />
          <ThemeToggle />
          <NotificationBell ws={ws} />
          <UserMenu ws={ws} me={me} roles={current?.roles ?? []} />
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        {navOpen ? <button type="button" className="fixed inset-0 z-40 bg-inverse/30 md:hidden" aria-label={t("layer.close")} onClick={() => setNavOpen(false)} /> : null}
        <aside
          className={cn(
            // Full sidebar from 1280 px; an icon rail from 768 px; a slide-in panel on phones (DS-003).
            "shrink-0 overflow-y-auto border-r border-border bg-card pb-6 md:w-16 md:px-2 xl:w-60 xl:px-3",
            navOpen ? "fixed inset-y-0 left-0 z-50 w-64 px-3 shadow-xl md:static md:shadow-none" : "hidden md:block",
          )}
          data-testid="sidebar"
        >
          <nav aria-label={t("shell.navigation")} className="flex flex-col gap-0.5">
            <SectionLabel>{t("shell.workspace")}</SectionLabel>
            {NAV.map((item) => (
              <NavLink key={item.to} item={item} ws={ws} exact={item.to === "/w/$ws"} />
            ))}
            <SectionLabel>{t("shell.admin")}</SectionLabel>
            {ADMIN.filter((item) => canSee(item, me, ws)).map((item) => (
              <NavLink key={item.to} item={item} ws={ws} />
            ))}
            {SETTINGS_PAGES.some((p) => canSee(p, me, ws)) ? (
              <Link to={SETTINGS_HUB} params={{ ws }} className={cn(linkClass, inSettings && activeClass)} data-testid="nav-settings" aria-current={inSettings ? "page" : undefined} title={t("admin.settings")}>
                <Settings className="size-4 shrink-0" aria-hidden />
                <span className={labelClass}>{t("admin.settings")}</span>
              </Link>
            ) : null}
            {me.isOrgAdmin ? (
              <>
                <SectionLabel>{t("shell.organization")}</SectionLabel>
                <Link to="/org/workspaces" className={linkClass} data-testid="nav-org-console" title={t("org.console")}>
                  <Building2 className="size-4 shrink-0" aria-hidden />
                  <span className={labelClass}>{t("org.console")}</span>
                </Link>
              </>
            ) : null}
          </nav>
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto" data-testid="main-scroll">
          {archived ? (
            <div role="status" className="flex flex-wrap items-center gap-3 border-b border-warning/40 bg-warning-soft px-6 py-2.5 text-sm text-warning-text" data-testid="archived-banner">
              <Archive className="size-4 shrink-0" aria-hidden />
              <span className="flex-1">{t("shell.archivedBanner")}</span>
              <Link to="/org/workspaces" className="font-medium underline">{t("shell.archivedManage")}</Link>
            </div>
          ) : null}
          {inSettings ? <SettingsStrip ws={ws} me={me} /> : null}
          {children}
        </main>
      </div>
      <GlobalSearch ws={ws} dimensions={dimensions} open={searching} onOpenChange={setSearching} />
      <ShortcutsDialog open={shortcuts} onOpenChange={setShortcuts} />
      <Toaster />
    </div>
  );
}

/** `?` opens the shortcuts; `g` then h / o / b / a / l goes to Home, Overview, Budgets, Approvals, Alerts. */
function useShortcuts(ws: string, onHelp: () => void): void {
  const navigate = useNavigate();
  // Keyboard shortcuts are UI, not data fetching.
  useEffect(() => {
    let pendingG = 0;
    const typing = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e)) return;
      if (e.key === "?") {
        e.preventDefault();
        onHelp();
        return;
      }
      if (e.key === "g") {
        pendingG = Date.now();
        return;
      }
      if (Date.now() - pendingG > 1200) return;
      pendingG = 0;
      const to = { h: "/w/$ws/home", o: "/w/$ws", b: "/w/$ws/budgets", a: "/w/$ws/approvals", l: "/w/$ws/alerts" }[e.key];
      if (to) {
        e.preventDefault();
        void navigate({ to: to as "/w/$ws", params: { ws } });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ws, navigate, onHelp]);
}

function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }): ReactElement {
  const rows: Array<[string[], MessageKey]> = [
    [["⌘", "K"], "shortcuts.search"],
    [["/"], "shortcuts.search"],
    [["?"], "shortcuts.help"],
    [["g", "h"], "shortcuts.goHome"],
    [["g", "b"], "shortcuts.goBudgets"],
    [["g", "a"], "shortcuts.goApprovals"],
    [["g", "l"], "shortcuts.goAlerts"],
    [["Esc"], "shortcuts.close"],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t("shortcuts.title")} data-testid="shortcuts-dialog">
        <ul className="flex flex-col divide-y divide-border text-sm">
          {rows.map(([keys, label]) => (
            <li key={`${keys.join("+")}-${label}`} className="flex items-center justify-between py-2">
              <span>{t(label)}</span>
              <span className="flex gap-1">
                {keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

/** The browser tab says where you are: "Budgets · Golden · BudgetOS" (UX-005). */
function useDocumentTitle(pathname: string, ws: string, workspace: string | undefined): void {
  const base = `/w/${ws}`;
  const rest = pathname.startsWith(base) ? pathname.slice(base.length) || "/" : pathname;
  const items = [...NAV, ...ADMIN, ...SETTINGS_PAGES, { to: SETTINGS_HUB, label: "admin.settings" as MessageKey, icon: Settings }];
  const match = items
    .map((i) => ({ i, path: i.to.replace("/w/$ws", "") || "/" }))
    .filter(({ path }) => (path === "/" ? rest === "/" : rest === path || rest.startsWith(`${path}/`)))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const title = [match ? t(match.i.label) : rest === "/search" ? t("nav.search") : null, workspace, t("app.name")].filter(Boolean).join(" · ");
  // Setting the tab title is UI, not data fetching.
  useEffect(() => {
    document.title = title;
  }, [title]);
}

/** UX-012: Light, Dark or the system's choice, for this browser. */
/** Day / night in one click from the header; the user menu keeps the three-way picker (with "same as your system"). */
function ThemeToggle(): ReactElement {
  const { resolved } = useTheme();
  const next = resolved === "dark" ? "light" : "dark";
  const label = t(next === "dark" ? "theme.toDark" : "theme.toLight");
  return (
    <Button variant="ghost" size="icon" onClick={() => setThemeChoice(next)} aria-label={label} title={label} data-testid="theme-toggle" data-resolved={resolved}>
      {resolved === "dark" ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
    </Button>
  );
}

function ThemePicker(): ReactElement {
  const { choice } = useTheme();
  const options: Array<{ id: ThemeChoice; label: MessageKey; icon: LucideIcon }> = [
    { id: "light", label: "theme.light", icon: Sun },
    { id: "dark", label: "theme.dark", icon: Moon },
    { id: "system", label: "theme.system", icon: Monitor },
  ];
  return (
    <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-sm" role="radiogroup" aria-label={t("theme.label")} data-testid="theme-picker">
      <span className="text-muted-foreground">{t("theme.label")}</span>
      <span className="inline-flex rounded-lg border border-border bg-muted/60 p-0.5">
        {options.map((o) => {
          const Icon = o.icon;
          return (
            <button key={o.id} type="button" role="radio" aria-checked={choice === o.id} title={t(o.label)} className={cn("grid size-7 place-items-center rounded-md text-muted-foreground", choice === o.id && "bg-card text-foreground shadow-xs")} onClick={() => setThemeChoice(o.id)} data-testid={`theme-${o.id}`}>
              <Icon className="size-4" aria-hidden />
              <span className="sr-only">{t(o.label)}</span>
            </button>
          );
        })}
      </span>
    </div>
  );
}

/**
 * The signed-in person (DS-003): who they are, their roles here, their name (editable; what Home
 * greets them by) and sign out, in one menu.
 */
function UserMenu({ ws, me, roles }: { ws: string; me: Me; roles: string[] }): ReactElement {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(me.user.name);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    meta: { success: t("toast.profileSaved") },
    mutationFn: async (n: string) => unwrap(api.PATCH("/api/v1/me", { params: { header: { "X-Workspace-Id": ws } }, body: { name: n } as never })),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["me"] });
      setOpen(false);
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });
  const roleLabels = roles.map((r) => t(`role.${r.toLowerCase()}` as MessageKey));
  return (
    <Popover open={open} onOpenChange={(o) => (setOpen(o), o && (setDraft(me.user.name), setError(null)))}>
      <PopoverTrigger asChild>
        <button type="button" className="flex max-w-64 items-center gap-2 rounded-lg px-1.5 py-1 text-right hover:bg-accent" aria-label={t("user.menu")} data-testid="profile-button">
          <span className="hidden min-w-0 flex-col items-end lg:flex">
            <span className="max-w-48 truncate text-sm font-medium" data-testid="user-name">{me.user.name}</span>
            <span className="max-w-48 truncate text-xs text-muted-foreground" data-testid="user-email">{me.user.email}</span>
          </span>
          <Avatar name={me.user.name} id={me.user.id} size={30} />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" data-testid="user-menu">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Avatar name={me.user.name} id={me.user.id} size={36} />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{me.user.name}</span>
            <span className="block truncate text-xs text-muted-foreground">{me.user.email}</span>
          </span>
        </div>
        {roleLabels.length ? (
          <div className="border-b border-border px-4 py-2.5 text-xs">
            <span className="text-muted-foreground">{t("user.roles")}: </span>
            <span className="font-medium">{roleLabels.join(", ")}</span>
          </div>
        ) : null}
        <form
          className="flex flex-col gap-2 px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) save.mutate(draft.trim());
          }}
          data-testid="profile-form"
        >
          <FormField label={t("profile.edit")} help={t("profile.help")} error={error ?? undefined}>
            {(ids) => <Input {...ids} value={draft} onChange={(e) => setDraft(e.target.value)} data-testid="profile-name" />}
          </FormField>
          <div className="flex justify-end">
            {draft.trim() && !save.isPending ? (
              <Button type="submit" size="sm" data-testid="profile-save">{t("profile.save")}</Button>
            ) : (
              <Button type="button" size="sm" disabled reason={save.isPending ? t("shell.loading") : t("profile.needName")}>{t("profile.save")}</Button>
            )}
          </div>
        </form>
        <ThemePicker />
        <div className="border-t border-border p-1.5">
          <button type="button" className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm hover:bg-accent" onClick={() => clearToken()} data-testid="sign-out">
            <LogOut className="size-4 text-muted-foreground" aria-hidden />
            {t("shell.signOut")}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
