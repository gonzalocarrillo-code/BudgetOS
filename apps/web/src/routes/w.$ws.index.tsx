import { formatMoney } from "@budget/grid";
import { cn, Button } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, CheckCircle2, Clock, Database, SlidersHorizontal, XCircle } from "lucide-react";
import { useRef, useState, type ReactElement, type ReactNode } from "react";
import { z } from "zod";
import { Card, Page } from "../components/page.js";
import { SeverityChip } from "./w.$ws.alerts.js";
import { api, unwrap } from "../lib/api.js";
import { meQuery, periodsQuery, SavedView } from "../lib/queries.js";
import { CellEditor, type CellRef } from "../features/overview/cell-editor.js";

/**
 * Overview (spec §18.5, plan §11.1 / Epic 1.11): glanceable risk with zero configuration. Pacing
 * by market × platform, the budgets most over and under pace, KPI against target by market, open
 * alerts, approvals waiting for me and how fresh the data is — one request, every number from the
 * server. Colours always come with their legend and the number they stand for.
 */
const PRESETS = ["current_month", "current_quarter", "current_year", "ytd", "last_90_days"] as const;
// A relative preset, or one of the workspace's own periods as `fiscal:<key>` (as in Budgets).
const PeriodParam = z.union([z.enum(PRESETS), z.string().regex(/^fiscal:[A-Za-z0-9_-]{1,40}$/)]);
// Heatmap axes: any two granularities of the registry (product feedback 8), kept in the URL.
const OverviewSearch = z.object({ period: PeriodParam.catch("current_year").default("current_year"), rows: z.string().optional(), cols: z.string().optional() });
type OverviewSearch = z.infer<typeof OverviewSearch>;
export const Route = createFileRoute("/w/$ws/")({ validateSearch: OverviewSearch, search: { middlewares: [stripSearchParams({ period: "current_year" })] }, component: OverviewPage });

const Num = z.string().nullable().optional();
const Leaf = z.object({ envelopeId: z.string().uuid().nullable(), name: z.string(), path: z.array(z.string()), budget: Num, actual: Num, pace_index: Num, spend_to_date_pct: Num }).passthrough();
const Overview = z.object({
  currency: z.string(),
  period: z.object({ preset: z.string(), start: z.string().optional(), end: z.string().optional(), elapsed: z.string().optional() }).passthrough(),
  dataAsOf: z.string(),
  totals: z.record(z.string(), z.string().nullable()),
  heatmap: z
    .object({
      rowDimension: z.object({ key: z.string(), label: z.string() }),
      colDimension: z.object({ key: z.string(), label: z.string() }),
      rows: z.array(z.string()),
      cols: z.array(z.string()),
      labels: z.object({ rows: z.record(z.string(), z.string()), cols: z.record(z.string(), z.string()) }),
      cells: z.array(z.object({ row: z.string().nullable(), col: z.string().nullable(), budget: Num, actual: Num, pace_index: Num, spend_to_date_pct: Num }).passthrough()),
      dimensions: z.array(z.object({ key: z.string(), label: z.string() })).default([]),
    })
    .nullable(),
  variances: z.object({ over: z.array(Leaf), under: z.array(Leaf) }),
  kpi: z.object({ metric: z.string(), dimension: z.object({ key: z.string(), label: z.string() }), rows: z.array(z.object({ code: z.string().nullable(), label: z.string().nullable(), budget: Num, actual: Num, target: Num, vsTargetPct: Num })) }).nullable(),
  alerts: z.object({ open: z.number(), counts: z.record(z.string(), z.number()), latest: z.array(z.object({ id: z.string(), severity: z.string(), envelopeId: z.string(), envelopeName: z.string().nullable(), ruleName: z.string().nullable() }).passthrough()) }),
  approvals: z.object({ mine: z.number(), overdue: z.number(), due: z.array(z.object({ id: z.string(), summary: z.string().nullable(), dueAt: z.string().nullable(), requestedByName: z.string().nullable().optional() }).passthrough()) }),
  freshness: z.object({ lastFactDate: z.string().nullable(), sources: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string(), isActive: z.boolean(), lastRun: z.object({ status: z.string(), startedAt: z.string(), finishedAt: z.string().nullable(), matchCoverage: z.string().nullable() }).nullable() })) }),
  elapsedMs: z.number(),
});
type Overview = z.infer<typeof Overview>;

/**
 * What each person sees (product feedback: "what we see and what we don't see"): tiles and panels
 * they turned off, kept on the server as their private `overview` saved view. A view the
 * workspace shares is everyone's default until they save their own.
 */
const SECTIONS = ["tile.budget", "tile.actual", "tile.spent", "tile.projected", "tile.alerts", "tile.approvals", "heatmap", "overPace", "underPace", "kpi", "alerts", "approvals", "freshness"] as const;
type Section = (typeof SECTIONS)[number];
const LAYOUT_NAME = "Overview layout";
const Layout = z.object({ hidden: z.array(z.string()).default([]) });

function useLayout(ws: string) {
  const client = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const viewsKey = ["saved-views", ws, "overview"];
  const viewsQuery = {
    queryKey: viewsKey,
    queryFn: async () => z.array(SavedView).parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/saved-views", { params: { path: { ws }, query: { screen: "overview" } as never } }))),
  };
  const { data: views = [] } = useQuery(viewsQuery);
  const mineOf = (vs: SavedView[]) => vs.find((v) => v.createdBy === me?.user.id && v.visibility === "private") ?? null;
  const mine = mineOf(views);
  const shared = views.find((v) => v.visibility === "workspace") ?? null;
  // The choice shows at once; saves run one after another, and the last one's result stays shown.
  const [pending, setPending] = useState<string[] | null>(null);
  const latest = useRef<string[] | null>(null);
  const hidden = new Set(pending ?? Layout.parse((mine ?? shared)?.definition ?? {}).hidden);
  const save = useMutation({
    scope: { id: `overview-layout-${ws}` },
    mutationFn: async (next: string[]) => {
      // Looked up fresh: the save before this one may have just created the view.
      const current = mineOf(await client.fetchQuery({ ...viewsQuery, staleTime: 0 }));
      return current
        ? unwrap(api.PATCH("/api/v1/saved-views/{id}", { params: { path: { id: current.id }, header: { "X-Workspace-Id": ws } }, body: { definition: { hidden: next } } as never }))
        : unwrap(api.POST("/api/v1/workspaces/{ws}/saved-views", { params: { path: { ws } }, body: { name: LAYOUT_NAME, screen: "overview", definition: { hidden: next }, visibility: "private" } as never }));
    },
    onSettled: async (_r, _e, next) => {
      await client.invalidateQueries({ queryKey: viewsKey });
      if (latest.current === next) setPending(null);
    },
  });
  const shows = (s: Section) => !hidden.has(s);
  const apply = (next: string[]) => {
    latest.current = next;
    setPending(next);
    save.mutate(next);
  };
  const toggle = (s: Section) => apply(hidden.has(s) ? [...hidden].filter((x) => x !== s) : [...hidden, s]);
  const reset = () => apply([]);
  return { shows, toggle, reset, hiddenCount: hidden.size, saving: save.isPending, ready: me !== undefined };
}

function Customise({ layout }: { layout: ReturnType<typeof useLayout> }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid="overview-customise">
        <SlidersHorizontal className="size-4" aria-hidden />
        {layout.hiddenCount ? t("overview.customise.withHidden", { count: layout.hiddenCount }) : t("overview.customise")}
      </Button>
      {open ? (
        <div className="absolute right-0 top-10 z-30 flex w-64 flex-col gap-1 rounded-xl border border-border bg-card p-3 shadow-lg" role="dialog" aria-label={t("overview.customise")} data-testid="overview-customise-menu">
          <p className="pb-1 text-xs text-muted-foreground">{t("overview.customise.help")}</p>
          {SECTIONS.map((s) => (
            <label key={s} className="flex items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-accent">
              <input type="checkbox" checked={layout.shows(s)} onChange={() => layout.toggle(s)} data-testid={`customise-${s}`} />
              {t(`overview.section.${s}` as MessageKey)}
            </label>
          ))}
          <div className="flex justify-between pt-2">
            {layout.hiddenCount ? (
              <Button size="sm" variant="ghost" onClick={layout.reset} data-testid="customise-reset">{t("overview.customise.reset")}</Button>
            ) : (
              <Button size="sm" variant="ghost" disabled reason={t("overview.customise.nothingHidden")}>{t("overview.customise.reset")}</Button>
            )}
            <Button size="sm" onClick={() => setOpen(false)}>{t("overview.customise.done")}</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const overviewQuery = (ws: string, period: string, rows?: string, cols?: string) =>
  queryOptions({
    queryKey: ["overview", ws, period, rows ?? "", cols ?? ""],
    queryFn: async () => Overview.parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/overview", { params: { path: { ws }, query: { period, ...(rows ? { rows } : {}), ...(cols ? { cols } : {}) } as never } }))),
    staleTime: 30_000,
  });

/** Pace bands: the legend and the cell colours use the same thresholds. */
const BANDS = [
  { max: 0.8, key: "overview.pace.under", cls: "bg-primary/25" },
  { max: 0.95, key: "overview.pace.slightlyUnder", cls: "bg-primary/10" },
  { max: 1.05, key: "overview.pace.on", cls: "bg-success/20" },
  { max: 1.2, key: "overview.pace.slightlyOver", cls: "bg-warning/30" },
  { max: Infinity, key: "overview.pace.over", cls: "bg-destructive/25" },
] as const;
const band = (pace: number | null) => (pace === null ? null : (BANDS.find((b) => pace < b.max) ?? BANDS[BANDS.length - 1]));
const pct = (v: string | null | undefined) => (v === null || v === undefined ? "—" : `${(Number(v) * 100).toFixed(0)}%`);
const pace = (v: string | null | undefined) => (v === null || v === undefined ? "—" : Number(v).toFixed(2));

function OverviewPage(): ReactElement {
  const { ws } = Route.useParams();
  const { period, rows, cols } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: o, error, isPending } = useQuery(overviewQuery(ws, period, rows, cols));
  const { data: periods = [] } = useQuery(periodsQuery(ws));
  const layout = useLayout(ws);
  const [cell, setCell] = useState<CellRef | null>(null);
  const money = (v: string | null | undefined) => (v === null || v === undefined ? "—" : formatMoney(v, o?.currency ?? "USD"));
  const periodSpec = period.startsWith("fiscal:") ? { kind: "fiscal", key: period.slice("fiscal:".length) } : { kind: "relative", preset: period };
  const tiles = [
    layout.shows("tile.budget") ? <Tile key="b" label={t("overview.budget")} value={o ? money(o.totals["budget"]) : ""} /> : null,
    layout.shows("tile.actual") ? <Tile key="a" label={t("overview.actual")} value={o ? money(o.totals["actual"]) : ""} hint={o ? t("overview.spendToDate", { pct: pct(o.totals["spend_to_date_pct"] ?? null) }) : undefined} /> : null,
    // % of the budget spent (product feedback 8), against how much of the period has gone.
    layout.shows("tile.spent") ? <Tile key="s" label={t("overview.spent")} value={o ? pct(o.totals["spend_to_date_pct"] ?? null) : ""} hint={o?.period.elapsed ? t("overview.elapsed", { pct: pct(o.period.elapsed) }) : undefined} testId="tile-spent" /> : null,
    // A projection needs projection facts; without them it would read 0%.
    layout.shows("tile.projected") ? <Tile key="p" label={t("overview.projectedClose")} value={o ? (Number(o.totals["projected"] ?? 0) === 0 ? "—" : pct(o.totals["projected_close_pct"])) : ""} hint={o && Number(o.totals["projected"] ?? 0) === 0 ? t("overview.noProjections") : undefined} /> : null,
    layout.shows("tile.alerts") ? <Tile key="al" label={t("overview.openAlerts")} value={o ? String(o.alerts.open) : ""} to="alerts" ws={ws} testId="tile-alerts" /> : null,
    layout.shows("tile.approvals") ? <Tile key="ap" label={t("overview.approvalsMine")} value={o ? String(o.approvals.mine) : ""} hint={o?.approvals.overdue ? t("overview.overdue", { n: o.approvals.overdue }) : undefined} to="approvals" ws={ws} testId="tile-approvals" /> : null,
  ].filter((x) => x !== null);

  return (
    <Page
      title={t("nav.overview")}
      actions={
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            {t("overview.period")}
            <select className="h-8 rounded-md border border-input bg-card px-2 text-sm text-foreground" value={period} onChange={(e) => void navigate({ search: (prev: OverviewSearch) => ({ ...prev, period: e.target.value }) })} data-testid="overview-period">
              {PRESETS.map((p) => (
                <option key={p} value={p}>
                  {t(`explorer.period.${p}` as MessageKey)}
                </option>
              ))}
              {/* The workspace's own years, quarters and custom periods (Admin › Fiscal calendar). */}
              {periods.length ? (
                <optgroup label={t("explorer.period.calendar")}>
                  {periods
                    .filter((p) => p.kind !== "month")
                    .map((p) => (
                      <option key={p.id} value={`fiscal:${p.key}`}>
                        {p.key} · {p.start} – {p.end}
                      </option>
                    ))}
                </optgroup>
              ) : null}
            </select>
          </label>
          <Customise layout={layout} />
        </div>
      }
    >
      {error ? <p role="alert" className="text-sm text-destructive">{error.message}</p> : null}
      {isPending || !o ? (
        <p className="text-sm text-muted-foreground" data-testid="overview-loading">{t("shell.loading")}</p>
      ) : (
        <div className="flex flex-col gap-5" data-testid="overview" data-ready="true" data-period={period}>
          {tiles.length ? (
            // Wide enough for a seven-figure amount: tiles wrap instead of cutting it off.
            <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3" data-testid="overview-tiles">
              {tiles}
            </div>
          ) : null}

          {o.heatmap && layout.shows("heatmap") ? <Heatmap h={o.heatmap} money={money} onAxes={(axes) => void navigate({ search: (prev: OverviewSearch) => ({ ...prev, ...axes }) })} onCell={setCell} /> : null}

          {layout.shows("overPace") || layout.shows("underPace") ? (
            <div className="grid gap-5 lg:grid-cols-2">
              {layout.shows("overPace") ? (
                <Card title={t("overview.overPace")}>
                  <LeafList ws={ws} rows={o.variances.over} icon={<ArrowUpRight className="size-4 text-destructive" aria-hidden />} money={money} testId="over-pace" />
                </Card>
              ) : null}
              {layout.shows("underPace") ? (
                <Card title={t("overview.underPace")}>
                  <LeafList ws={ws} rows={o.variances.under} icon={<ArrowDownRight className="size-4 text-secondary-foreground" aria-hidden />} money={money} testId="under-pace" />
                </Card>
              ) : null}
            </div>
          ) : null}

          <div className="grid gap-5 lg:grid-cols-3">
            {o.kpi && layout.shows("kpi") ? (
              <Card title={t("overview.kpi", { metric: o.kpi.metric.toUpperCase(), dimension: o.kpi.dimension.label })}>
                <table className="tabular w-full text-sm" data-testid="kpi-table">
                  <thead className="text-left text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-2 font-medium">{o.kpi.dimension.label}</th>
                      <th className="py-1 pr-2 text-right font-medium">{t("overview.kpiActual")}</th>
                      <th className="py-1 pr-2 text-right font-medium">{t("overview.kpiTarget")}</th>
                      <th className="py-1 text-right font-medium">{t("overview.kpiGap")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {o.kpi.rows.map((r) => {
                      const gap = r.vsTargetPct === null || r.vsTargetPct === undefined ? null : Number(r.vsTargetPct);
                      return (
                        <tr key={r.code ?? "none"} className="border-t border-border" data-testid="kpi-row">
                          <td className="py-1 pr-2">{r.label ?? r.code ?? "—"}</td>
                          <td className="py-1 pr-2 text-right">{r.actual ?? "—"}</td>
                          <td className="py-1 pr-2 text-right">{r.target ?? "—"}</td>
                          <td className={cn("py-1 text-right", gap === null ? "" : gap > 0 ? "text-destructive" : "text-success")}>{gap === null ? "—" : `${gap > 0 ? "+" : ""}${(gap * 100).toFixed(1)}%`}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="mt-2 text-xs text-muted-foreground">{t("overview.kpiHelp")}</p>
              </Card>
            ) : null}
            {layout.shows("alerts") ? (
            <Card title={t("overview.alerts")}>
              <div className="flex flex-col gap-2" data-testid="overview-alerts">
                <div className="flex flex-wrap gap-2">
                  {Object.entries(o.alerts.counts).filter(([, n]) => n > 0).map(([s, n]) => (
                    <span key={s} className="inline-flex items-center gap-1">
                      <SeverityChip severity={s} />
                      <span className="tabular text-sm">{n}</span>
                    </span>
                  ))}
                  {o.alerts.open === 0 ? <span className="text-sm text-muted-foreground">{t("overview.noAlerts")}</span> : null}
                </div>
                <ul className="flex flex-col gap-1 text-sm">
                  {o.alerts.latest.map((a) => (
                    <li key={a.id} className="flex items-center gap-2">
                      <AlertTriangle className="size-3.5 shrink-0 text-warning" aria-hidden />
                      <Link to="/w/$ws/budgets" params={{ ws }} search={{ select: a.envelopeId } as never} className="min-w-0 flex-1 truncate hover:text-primary">
                        {a.envelopeName ?? a.envelopeId}
                      </Link>
                      <span className="truncate text-xs text-muted-foreground">{a.ruleName}</span>
                    </li>
                  ))}
                </ul>
                <Link to="/w/$ws/alerts" params={{ ws }} className="text-sm text-primary hover:underline">{t("overview.allAlerts")}</Link>
              </div>
            </Card>
            ) : null}
            {layout.shows("approvals") ? (
            <Card title={t("overview.approvals")}>
              <div className="flex flex-col gap-2" data-testid="overview-approvals">
                {o.approvals.due.length === 0 ? <p className="text-sm text-muted-foreground">{t("overview.noApprovals")}</p> : null}
                <ul className="flex flex-col gap-1.5 text-sm">
                  {o.approvals.due.map((r) => {
                    const overdue = r.dueAt !== null && Date.parse(r.dueAt) < Date.now();
                    return (
                      <li key={r.id}>
                        <Link to="/w/$ws/approvals/$id" params={{ ws, id: r.id }} className="line-clamp-2 hover:text-primary" data-testid="overview-approval">
                          {r.summary ?? r.id}
                        </Link>
                        <span className={cn("text-xs", overdue ? "text-destructive" : "text-muted-foreground")}>
                          {r.dueAt ? t(overdue ? "overview.wasDue" : "overview.due", { date: new Date(r.dueAt).toLocaleDateString() }) : ""}
                          {r.requestedByName ? ` · ${r.requestedByName}` : ""}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <Link to="/w/$ws/approvals" params={{ ws }} search={{ tab: "mine" }} className="text-sm text-primary hover:underline">{t("overview.allApprovals")}</Link>
              </div>
            </Card>
            ) : null}
          </div>

          {layout.shows("freshness") ? (
          <Card title={t("overview.freshness")}>
            <div className="flex flex-col gap-2 text-sm" data-testid="overview-freshness">
              <p className="flex items-center gap-2">
                <Database className="size-4 text-muted-foreground" aria-hidden />
                {o.freshness.lastFactDate ? t("overview.lastFact", { date: o.freshness.lastFactDate }) : t("overview.noFacts")}
                <span className="text-xs text-muted-foreground">· {t("overview.asOf", { at: new Date(o.dataAsOf).toLocaleString() })}</span>
              </p>
              <ul className="flex flex-wrap gap-x-6 gap-y-1">
                {o.freshness.sources.map((s) => {
                  const st = s.lastRun?.status;
                  const Icon = st === "ok" ? CheckCircle2 : st === "failed" ? XCircle : Clock;
                  return (
                    <li key={s.id} className="flex items-center gap-1.5" data-testid="freshness-source">
                      <Icon className={cn("size-4", st === "ok" ? "text-success" : st === "failed" ? "text-destructive" : "text-muted-foreground")} aria-hidden />
                      <span className="font-medium">{s.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {s.lastRun ? t("overview.lastRun", { status: t(`sources.run.${s.lastRun.status}` as MessageKey), when: new Date(s.lastRun.finishedAt ?? s.lastRun.startedAt).toLocaleString(), coverage: s.lastRun.matchCoverage ? pct(s.lastRun.matchCoverage) : "—" }) : t("overview.neverRun")}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </Card>
          ) : null}
          {tiles.length === 0 && layout.hiddenCount >= SECTIONS.length ? <p className="text-sm text-muted-foreground" data-testid="overview-all-hidden">{t("overview.customise.allHidden")}</p> : null}
        </div>
      )}
      {cell && o ? <CellEditor ws={ws} cell={cell} period={periodSpec} currency={o.currency} onClose={() => setCell(null)} /> : null}
    </Page>
  );
}

function Tile({ label, value, hint, to, ws, testId }: { label: string; value: string; hint?: string | undefined; to?: "alerts" | "approvals"; ws?: string; testId?: string }): ReactElement {
  const body = (
    <>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="tabular whitespace-nowrap text-lg font-semibold tracking-[-0.02em]" title={value}>{value}</span>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </>
  );
  const cls = "flex flex-col gap-0.5 rounded-xl border border-border bg-card px-4 py-3 shadow-xs";
  if (to && ws)
    return to === "alerts" ? (
      <Link to="/w/$ws/alerts" params={{ ws }} className={cn(cls, "hover:border-primary")} data-testid={testId}>
        {body}
      </Link>
    ) : (
      <Link to="/w/$ws/approvals" params={{ ws }} search={{ tab: "mine" }} className={cn(cls, "hover:border-primary")} data-testid={testId}>
        {body}
      </Link>
    );
  return (
    <div className={cls} data-testid={testId}>
      {body}
    </div>
  );
}

const COLS_SHOWN = 8;
const ROWS_SHOWN = 12;

function Heatmap({ h, money, onAxes, onCell }: { h: NonNullable<Overview["heatmap"]>; money: (v: string | null | undefined) => string; onAxes: (axes: { rows?: string; cols?: string }) => void; onCell: (cell: CellRef) => void }): ReactElement {
  const cell = (row: string, col: string) => h.cells.find((c) => c.row === row && c.col === col);
  const label = (kind: "rows" | "cols", code: string) => h.labels[kind][code] ?? code;
  const [allCols, setAllCols] = useState(false);
  const [allRows, setAllRows] = useState(false);
  const cols = allCols ? h.cols : h.cols.slice(0, COLS_SHOWN);
  const rows = allRows ? h.rows : h.rows.slice(0, ROWS_SHOWN);
  const axis = (which: "rows" | "cols", value: string, other: string) => (
    <label className="flex items-center gap-1.5 text-sm font-normal text-muted-foreground">
      {t(which === "rows" ? "overview.axis.rows" : "overview.axis.cols")}
      <select className="h-8 rounded-md border border-input bg-card px-2 text-sm text-foreground" value={value} onChange={(e) => onAxes({ [which]: e.target.value })} data-testid={`heatmap-${which}`}>
        {h.dimensions.filter((d) => d.key !== other).map((d) => (
          <option key={d.key} value={d.key}>{d.label}</option>
        ))}
      </select>
    </label>
  );
  return (
    <Card title={t("overview.heatmap", { rows: h.rowDimension.label, cols: h.colDimension.label })}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          {axis("rows", h.rowDimension.key, h.colDimension.key)}
          <span className="text-muted-foreground" aria-hidden>×</span>
          {axis("cols", h.colDimension.key, h.rowDimension.key)}
          <span className="ml-auto text-xs text-muted-foreground">{t("overview.cellHint")}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="tabular w-full border-separate border-spacing-1 text-sm" data-testid="heatmap">
            <caption className="sr-only">{t("overview.heatmapCaption")}</caption>
            <thead>
              <tr>
                <th scope="col" className="px-2 text-left text-xs font-medium text-muted-foreground">
                  {h.rowDimension.label}
                </th>
                {cols.map((c) => (
                  <th key={c} scope="col" className="px-2 text-left text-xs font-medium text-muted-foreground" data-testid="heatmap-col" data-code={c}>
                    {label("cols", c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r} data-testid="heatmap-row" data-code={r}>
                  <th scope="row" className="max-w-48 truncate whitespace-nowrap px-2 text-left font-medium" title={label("rows", r)}>
                    {label("rows", r)}
                  </th>
                  {cols.map((c) => {
                    const x = cell(r, c);
                    const p = x?.pace_index === null || x?.pace_index === undefined ? null : Number(x.pace_index);
                    const spent = x?.spend_to_date_pct ?? null;
                    const b = band(p);
                    return (
                      <td key={c} className="p-0">
                        {x ? (
                          <button
                            type="button"
                            onClick={() => onCell({ row: { key: h.rowDimension.key, code: r, label: label("rows", r) }, col: { key: h.colDimension.key, code: c, label: label("cols", c) } })}
                            className={cn("flex w-full min-w-24 flex-col rounded-md px-2 py-1.5 text-left text-foreground hover:ring-2 hover:ring-primary", b?.cls ?? "bg-surface")}
                            aria-label={t("overview.cellLabel", { row: label("rows", r), col: label("cols", c), spent: pct(spent), budget: money(x.budget), actual: money(x.actual) })}
                            data-testid="heatmap-cell"
                          >
                            <span className="font-semibold" data-testid="heatmap-spent">{pct(spent)}</span>
                            <span className="text-xs text-muted-foreground">{money(x.budget)}</span>
                          </button>
                        ) : (
                          <span className="block min-w-24 rounded-md bg-surface/60 px-2 py-1.5 text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {h.cols.length > COLS_SHOWN ? (
            <Button size="sm" variant="ghost" onClick={() => setAllCols((v) => !v)} data-testid="heatmap-all-cols">
              {allCols ? t("overview.fewerCols") : t("overview.allCols", { count: h.cols.length, dimension: h.colDimension.label })}
            </Button>
          ) : null}
          {h.rows.length > ROWS_SHOWN ? (
            <Button size="sm" variant="ghost" onClick={() => setAllRows((v) => !v)} data-testid="heatmap-all-rows">
              {allRows ? t("overview.fewerRows") : t("overview.allRows", { count: h.rows.length, dimension: h.rowDimension.label })}
            </Button>
          ) : null}
        </div>
        <ul className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground" aria-label={t("overview.legend")} data-testid="heatmap-legend">
          <li className="font-medium">{t("overview.legendTitle")}</li>
          {BANDS.map((b) => (
            <li key={b.key} className="flex items-center gap-1.5">
              <span className={cn("inline-block size-3.5 rounded-sm border border-border", b.cls)} aria-hidden />
              {t(b.key)}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

function LeafList({ ws, rows, icon, money, testId }: { ws: string; rows: z.infer<typeof Leaf>[]; icon: ReactNode; money: (v: string | null | undefined) => string; testId: string }): ReactElement {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground" data-testid={testId}>{t("overview.noneHere")}</p>;
  return (
    <ol className="flex flex-col gap-1.5" data-testid={testId}>
      {rows.map((r) => (
        <li key={r.envelopeId ?? r.name} className="flex items-center gap-2 text-sm" data-testid="leaf-row">
          {icon}
          <Link to="/w/$ws/budgets" params={{ ws }} search={{ select: r.envelopeId } as never} className="min-w-0 flex-1 truncate hover:text-primary">
            <span className="font-medium">{r.name}</span>
            <span className="ml-2 text-xs text-muted-foreground">{r.path.slice(0, -1).at(-1)}</span>
          </Link>
          <span className="tabular whitespace-nowrap text-xs text-muted-foreground">{t("overview.leafLine", { actual: money(r.actual), budget: money(r.budget) })}</span>
          <span className="tabular w-12 text-right font-semibold" title={t("overview.paceTitle", { pace: pace(r.pace_index) })}>{pct(r.spend_to_date_pct ?? null)}</span>
        </li>
      ))}
    </ol>
  );
}
