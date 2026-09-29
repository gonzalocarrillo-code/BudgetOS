import { HEATMAP_SORTS, OverviewResponse, type OverviewBlock } from "@budget/domain";
import { AsOfChip, Select } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { Link, createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { useState, type ReactElement } from "react";
import { z } from "zod";
import { Page } from "../components/page.js";
import { ApiError, api, unwrap } from "../lib/api.js";
import { AlertsByRule, DataFooter, KpiPanel, QueuePanel } from "../features/overview/panels.js";
import { Attention } from "../features/overview/attention.js";
import { CellEditor, type CellRef } from "../features/overview/cell-editor.js";
import { Customise, useLayout } from "../features/overview/customise.js";
import { Headline } from "../features/overview/headline.js";
import { Heatmap } from "../features/overview/heatmap.js";
import { PeriodPicker } from "../features/periods/period-picker.js";
import { snapshotLabel, snapshotsQuery } from "../features/snapshots/queries.js";

/**
 * Overview (spec §18.5, plan §11.1, docs/HOME_OVERVIEW_PLAN.md §3.2): the state of the money. The
 * headline in money, pace by any two granularities with their totals, what needs attention ranked
 * by money at stake, alerts by rule, CPA against target, the approval queue and where the numbers
 * come from, in one request, every number and every order from the server. Pace is read as of the
 * data (ADR-062); what each person sees, and in what order, is their saved layout (HO-015).
 */
const PRESETS = ["current_month", "current_quarter", "current_year", "ytd", "last_90_days"] as const;
// A relative preset, or one of the workspace's own periods as `fiscal:<key>` (as in Budgets).
const PeriodParam = z.union([z.enum(PRESETS), z.string().regex(/^fiscal:[A-Za-z0-9_-]{1,40}$/)]);
// The heatmap's axes and sort, and the snapshot to compare with, all in the URL (the URL wins over
// what the layout remembers, so a shared link shows what its sender saw).
const OverviewSearch = z.object({
  period: PeriodParam.catch("current_year").default("current_year"),
  rows: z.string().optional(),
  cols: z.string().optional(),
  sort: z.enum(HEATMAP_SORTS).optional().catch(undefined),
  compareTo: z.string().uuid().optional().catch(undefined),
});
type OverviewSearch = z.infer<typeof OverviewSearch>;
export const Route = createFileRoute("/w/$ws/")({ validateSearch: OverviewSearch, search: { middlewares: [stripSearchParams({ period: "current_year" })] }, component: OverviewPage });

interface OverviewParams {
  period: string;
  rows?: string | undefined;
  cols?: string | undefined;
  sort?: string | undefined;
  compareTo?: string | undefined;
}
const defined = (p: OverviewParams) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== ""));

/**
 * One request. Rows or columns the layout remembers may name a granularity since retired (a 422):
 * then the default axes, rather than an Overview that no longer opens.
 */
const overviewQuery = (ws: string, p: OverviewParams, remembered: boolean) =>
  queryOptions({
    queryKey: ["overview", ws, defined(p)],
    queryFn: async () => {
      const get = async (q: OverviewParams) => OverviewResponse.parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/overview", { params: { path: { ws }, query: defined(q) as never } })));
      try {
        return await get(p);
      } catch (e) {
        if (remembered && e instanceof ApiError && e.status === 422) return get({ ...p, rows: undefined, cols: undefined });
        throw e;
      }
    },
    staleTime: 30_000,
  });

const shortDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" });
/** Panels that sit side by side when they follow each other in the layout. */
const PANELS: ReadonlySet<OverviewBlock> = new Set(["alerts", "kpi", "queue"]);

function OverviewPage(): ReactElement {
  const { ws } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const setSearch = (patch: Partial<OverviewSearch>) => void navigate({ search: (prev: OverviewSearch) => ({ ...prev, ...patch }) });
  const layout = useLayout(ws);
  const saved = layout.layout;
  const rows = search.rows ?? saved.axes.rows;
  const cols = search.cols ?? saved.axes.cols;
  const params: OverviewParams = { period: search.period, rows, cols, sort: search.sort ?? saved.sort, compareTo: search.compareTo };
  const remembered = (search.rows === undefined && saved.axes.rows !== undefined) || (search.cols === undefined && saved.axes.cols !== undefined);
  // The layout first: its remembered axes decide what to ask for (one request, not two).
  // A new period, axes or sort keeps the previous numbers on screen (not ready) until the new ones come.
  const { data: o, error, isPending, isPlaceholderData } = useQuery({ ...overviewQuery(ws, params, remembered), enabled: layout.ready, placeholderData: (prev) => prev });
  const { data: snapshots = [] } = useQuery(snapshotsQuery(ws));
  const [cell, setCell] = useState<CellRef | null>(null);
  const periodSpec = search.period.startsWith("fiscal:") ? { kind: "fiscal", key: search.period.slice("fiscal:".length) } : { kind: "relative", preset: search.period };
  const periodLabel = search.period.startsWith("fiscal:") ? search.period.slice("fiscal:".length) : t(`explorer.period.${search.period}` as MessageKey);

  const blocks = (data: OverviewResponse): ReactElement[] => {
    const out: ReactElement[] = [];
    let panels: ReactElement[] = [];
    const flush = () => {
      if (panels.length) out.push(<div key={`panels-${out.length}`} className={panels.length === 1 ? "grid gap-5" : panels.length === 2 ? "grid gap-5 lg:grid-cols-2" : "grid gap-5 lg:grid-cols-3"}>{panels}</div>);
      panels = [];
    };
    for (const b of saved.order) {
      const el = block(b, data);
      if (!el) continue;
      if (PANELS.has(b)) panels.push(el);
      else {
        flush();
        out.push(el);
      }
    }
    flush();
    return out;
  };
  const block = (b: OverviewBlock, data: OverviewResponse): ReactElement | null => {
    switch (b) {
      case "headline":
        return <Headline key="headline" ws={ws} o={data} shows={layout.shows} periodLabel={periodLabel} />;
      case "heatmap":
        return data.heatmap && layout.shows("heatmap") ? (
          <Heatmap
            key="heatmap"
            ws={ws}
            h={data.heatmap}
            currency={data.currency}
            through={data.asOf.through}
            period={periodSpec}
            compareName={data.compare?.explicit ? data.compare.name : null}
            elapsed={data.period.elapsed === undefined ? null : Number(data.period.elapsed)}
            onAxes={(axes) => {
              setSearch(axes);
              layout.remember(axes);
            }}
            onSort={(sort) => {
              setSearch({ sort });
              layout.remember({}, sort);
            }}
            onEdit={setCell}
          />
        ) : null;
      case "attention":
        return data.attention && layout.shows("attention") ? <Attention key="attention" ws={ws} a={data.attention} currency={data.currency} period={periodSpec} /> : null;
      case "alerts":
        return layout.shows("alerts") ? <AlertsByRule key="alerts" ws={ws} o={data} /> : null;
      case "kpi":
        return data.kpi && layout.shows("kpi") ? <KpiPanel key="kpi" ws={ws} kpi={data.kpi} /> : null;
      case "queue":
        return data.queue && layout.shows("queue") ? <QueuePanel key="queue" ws={ws} queue={data.queue} /> : null;
      case "data":
        return layout.shows("data") ? <DataFooter key="data" ws={ws} o={data} /> : null;
    }
  };

  const shown = o ? blocks(o) : [];
  return (
    <Page
      title={t("nav.overview")}
      actions={
        <div className="flex flex-wrap items-center gap-3">
          <PeriodPicker ws={ws} value={search.period} presets={PRESETS} onChange={(period) => setSearch({ period })} testId="overview-period" />
          {snapshots.length ? (
            <label className="flex items-center gap-2 text-sm text-muted-foreground" data-tour="overview-compare">
              {t("overview.compare")}
              <Select className="max-w-56 text-foreground" size="sm" value={search.compareTo ?? ""} onChange={(e) => setSearch({ compareTo: e.target.value || undefined })} data-testid="overview-compare">
                <option value="">{t("overview.compare.latestPlan")}</option>
                {snapshots.map((x) => (
                  <option key={x.id} value={x.id}>
                    {snapshotLabel(x)}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
          {o ? <AsOfChip through={o.asOf.through} stale={o.asOf.stale} staleDays={o.asOf.staleDays} grain={o.asOf.grain} testId="overview-as-of" /> : null}
          <Customise layout={layout} />
        </div>
      }
    >
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      ) : null}
      {o?.asOf.stale && o.asOf.through ? <StaleBanner ws={ws} through={o.asOf.through} days={o.asOf.staleDays ?? 0} /> : null}
      {isPending || !o ? (
        <p className="text-sm text-muted-foreground" data-testid="overview-loading">
          {t("shell.loading")}
        </p>
      ) : (
        <div className="flex min-w-0 flex-col gap-5" data-testid="overview" data-ready={isPlaceholderData ? "false" : "true"} data-period={o.period.preset} data-order={saved.order.join(",")}>
          {shown}
          {shown.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="overview-all-hidden">
              {t("overview.customise.allHidden")}
            </p>
          ) : null}
        </div>
      )}
      {cell && o ? <CellEditor ws={ws} cell={cell} period={periodSpec} currency={o.currency} onClose={() => setCell(null)} /> : null}
    </Page>
  );
}

/** HO-003: the actuals are late; every pace on the page is read as of their last day. */
function StaleBanner({ ws, through, days }: { ws: string; through: string; days: number }): ReactElement {
  return (
    <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/40 bg-warning-soft px-4 py-2.5 text-sm text-warning-text" data-testid="overview-stale">
      <AlertTriangle className="size-4 shrink-0" aria-hidden />
      <span className="flex-1">{t("overview.stale", { date: shortDate(through), days })}</span>
      <Link to="/w/$ws/sources" params={{ ws }} className="font-medium underline">
        {t("overview.staleOpen")}
      </Link>
    </div>
  );
}
