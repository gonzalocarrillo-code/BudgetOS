import { formatMoney } from "@budget/grid";
import { cn } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { Link, createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, CheckCircle2, Clock, Database, XCircle } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { z } from "zod";
import { Card, Page } from "../components/page.js";
import { SeverityChip } from "./w.$ws.alerts.js";
import { api, unwrap } from "../lib/api.js";

/**
 * Overview (spec §18.5, plan §11.1 / Epic 1.11): glanceable risk with zero configuration. Pacing
 * by market × platform, the budgets most over and under pace, KPI against target by market, open
 * alerts, approvals waiting for me and how fresh the data is — one request, every number from the
 * server. Colours always come with their legend and the number they stand for.
 */
const PRESETS = ["current_month", "current_quarter", "current_year", "ytd", "last_90_days"] as const;
const OverviewSearch = z.object({ period: z.enum(PRESETS).default("current_year") });
type OverviewSearch = z.infer<typeof OverviewSearch>;
export const Route = createFileRoute("/w/$ws/")({ validateSearch: OverviewSearch, search: { middlewares: [stripSearchParams({ period: "current_year" })] }, component: OverviewPage });

const Num = z.string().nullable().optional();
const Leaf = z.object({ envelopeId: z.string().uuid().nullable(), name: z.string(), path: z.array(z.string()), budget: Num, actual: Num, pace_index: Num, spend_to_date_pct: Num }).passthrough();
const Overview = z.object({
  currency: z.string(),
  dataAsOf: z.string(),
  totals: z.record(z.string(), z.string().nullable()),
  heatmap: z
    .object({
      rowDimension: z.object({ key: z.string(), label: z.string() }),
      colDimension: z.object({ key: z.string(), label: z.string() }),
      rows: z.array(z.string()),
      cols: z.array(z.string()),
      labels: z.object({ rows: z.record(z.string(), z.string()), cols: z.record(z.string(), z.string()) }),
      cells: z.array(z.object({ row: z.string().nullable(), col: z.string().nullable(), budget: Num, actual: Num, pace_index: Num }).passthrough()),
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

const overviewQuery = (ws: string, period: string) =>
  queryOptions({
    queryKey: ["overview", ws, period],
    queryFn: async () => Overview.parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/overview", { params: { path: { ws }, query: { period } as never } }))),
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
  const { period } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: o, error, isPending } = useQuery(overviewQuery(ws, period));
  const money = (v: string | null | undefined) => (v === null || v === undefined ? "—" : formatMoney(v, o?.currency ?? "USD"));

  return (
    <Page
      title={t("nav.overview")}
      actions={
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          {t("overview.period")}
          <select className="h-8 rounded-md border border-input bg-card px-2 text-sm text-foreground" value={period} onChange={(e) => void navigate({ search: (prev: OverviewSearch) => ({ ...prev, period: e.target.value as OverviewSearch["period"] }) })} data-testid="overview-period">
            {PRESETS.map((p) => (
              <option key={p} value={p}>
                {t(`explorer.period.${p}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
      }
    >
      {error ? <p role="alert" className="text-sm text-destructive">{error.message}</p> : null}
      {isPending || !o ? (
        <p className="text-sm text-muted-foreground" data-testid="overview-loading">{t("shell.loading")}</p>
      ) : (
        <div className="flex flex-col gap-5" data-testid="overview" data-ready="true" data-period={period}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6" data-testid="overview-tiles">
            <Tile label={t("overview.budget")} value={money(o.totals["budget"])} />
            <Tile label={t("overview.actual")} value={money(o.totals["actual"])} hint={t("overview.spendToDate", { pct: pct(o.totals["spend_to_date_pct"] ?? null) })} />
            <Tile label={t("overview.pace")} value={pace(o.totals["pace_index"])} hint={t("overview.paceHint")} />
            {/* A projection needs projection facts; without them it would read 0%. */}
            <Tile label={t("overview.projectedClose")} value={Number(o.totals["projected"] ?? 0) === 0 ? "—" : pct(o.totals["projected_close_pct"])} hint={Number(o.totals["projected"] ?? 0) === 0 ? t("overview.noProjections") : undefined} />
            <Tile label={t("overview.openAlerts")} value={String(o.alerts.open)} to="alerts" ws={ws} testId="tile-alerts" />
            <Tile label={t("overview.approvalsMine")} value={String(o.approvals.mine)} hint={o.approvals.overdue ? t("overview.overdue", { n: o.approvals.overdue }) : undefined} to="approvals" ws={ws} testId="tile-approvals" />
          </div>

          {o.heatmap ? <Heatmap ws={ws} h={o.heatmap} money={money} /> : null}

          <div className="grid gap-5 lg:grid-cols-2">
            <Card title={t("overview.overPace")}>
              <LeafList ws={ws} rows={o.variances.over} icon={<ArrowUpRight className="size-4 text-destructive" aria-hidden />} money={money} testId="over-pace" />
            </Card>
            <Card title={t("overview.underPace")}>
              <LeafList ws={ws} rows={o.variances.under} icon={<ArrowDownRight className="size-4 text-secondary-foreground" aria-hidden />} money={money} testId="under-pace" />
            </Card>
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            {o.kpi ? (
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
          </div>

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
        </div>
      )}
    </Page>
  );
}

function Tile({ label, value, hint, to, ws, testId }: { label: string; value: string; hint?: string | undefined; to?: "alerts" | "approvals"; ws?: string; testId?: string }): ReactElement {
  const body = (
    <>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="tabular whitespace-nowrap text-lg font-semibold tracking-[-0.02em]">{value}</span>
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

function Heatmap({ ws, h, money }: { ws: string; h: NonNullable<Overview["heatmap"]>; money: (v: string | null | undefined) => string }): ReactElement {
  const cell = (row: string, col: string) => h.cells.find((c) => c.row === row && c.col === col);
  const label = (kind: "rows" | "cols", code: string) => h.labels[kind][code] ?? code;
  return (
    <Card title={t("overview.heatmap", { rows: h.rowDimension.label, cols: h.colDimension.label })}>
      <div className="flex flex-col gap-3">
        <div className="overflow-x-auto">
          <table className="tabular w-full border-separate border-spacing-1 text-sm" data-testid="heatmap">
            <caption className="sr-only">{t("overview.heatmapCaption")}</caption>
            <thead>
              <tr>
                <th scope="col" className="px-2 text-left text-xs font-medium text-muted-foreground">
                  {h.rowDimension.label}
                </th>
                {h.cols.map((c) => (
                  <th key={c} scope="col" className="px-2 text-left text-xs font-medium text-muted-foreground">
                    {label("cols", c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {h.rows.map((r) => (
                <tr key={r} data-testid="heatmap-row" data-code={r}>
                  <th scope="row" className="max-w-48 truncate whitespace-nowrap px-2 text-left font-medium" title={label("rows", r)}>
                    {label("rows", r)}
                  </th>
                  {h.cols.map((c) => {
                    const x = cell(r, c);
                    const p = x?.pace_index === null || x?.pace_index === undefined ? null : Number(x.pace_index);
                    const b = band(p);
                    const filter = { logic: "and", children: [{ field: { kind: "dimension", key: h.rowDimension.key }, op: "eq", value: r }, { field: { kind: "dimension", key: h.colDimension.key }, op: "eq", value: c }] };
                    return (
                      <td key={c} className="p-0">
                        {x ? (
                          <Link
                            to="/w/$ws/budgets"
                            params={{ ws }}
                            search={{ view: "pivot", groupBy: [h.rowDimension.key, h.colDimension.key], filter } as never}
                            className={cn("flex min-w-24 flex-col rounded-md px-2 py-1.5 text-foreground hover:ring-2 hover:ring-primary", b?.cls ?? "bg-surface")}
                            aria-label={t("overview.cellLabel", { row: label("rows", r), col: label("cols", c), pace: p === null ? "—" : p.toFixed(2), budget: money(x.budget), actual: money(x.actual) })}
                            data-testid="heatmap-cell"
                          >
                            <span className="font-semibold">{p === null ? "—" : p.toFixed(2)}</span>
                            <span className="text-xs text-muted-foreground">{money(x.budget)}</span>
                          </Link>
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
          <span className="tabular w-12 text-right font-semibold">{pace(r.pace_index)}</span>
        </li>
      ))}
    </ol>
  );
}
