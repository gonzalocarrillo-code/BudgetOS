import { BulkPreview, FilterGroup, Grain, PeriodSpec, type FilterGroupT } from "@budget/domain";
import { BudgetGrid, parseMoney, formatMoney, type ColumnSpec, type GridEvents } from "@budget/grid";
import { Button, cn } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { useMemo, useState, type ReactElement } from "react";
import { z } from "zod";
import { Card, Page } from "../components/page.js";
import { EnvelopeDrawer } from "../features/explorer/drawer.js";
import { FilterBar } from "../features/explorer/filter-bar.js";
import { PasteDialog } from "../features/explorer/paste-dialog.js";
import { ExplorerRowSource, type ExplorerRow } from "../features/explorer/row-source.js";
import { SavedViews } from "../features/explorer/saved-views.js";
import { api, unwrap } from "../lib/api.js";
import { envelopeQuery, registryQuery, templatesQuery } from "../lib/queries.js";

/** Explorer search params are the source of truth for filter / grouping state (spec §18.1). */
const ExplorerSearch = z.object({
  filter: FilterGroup.default({ logic: "and", children: [] }),
  groupBy: z.array(z.string()).default([]),
  templateId: z.string().uuid().optional(),
  measures: z.array(z.string()).default(["budget", "actual", "projected", "pace_index"]),
  targets: z.array(z.string()).default([]),
  period: PeriodSpec.default({ kind: "relative", preset: "current_quarter" }),
  grain: Grain.default("total"),
  asOf: z.string().datetime().optional(),
  view: z.enum(["tree", "pivot", "timeline"]).default("tree"),
  zoom: z.enum(["week", "month", "quarter", "fy"]).default("month"),
  select: z.string().uuid().optional(),
  savedViewId: z.string().uuid().optional(),
  /** Expanded tree nodes (lz-string in the URL, spec §18.2). */
  expanded: z.array(z.string()).default([]),
});
type ExplorerSearchT = z.infer<typeof ExplorerSearch>;

const DEFAULTS = { filter: { logic: "and" as const, children: [] }, groupBy: [], measures: ["budget", "actual", "projected", "pace_index"], targets: [], period: { kind: "relative" as const, preset: "current_quarter" as const }, grain: "total" as const, view: "tree" as const, zoom: "month" as const, expanded: [] };

export const Route = createFileRoute("/w/$ws/budgets")({
  validateSearch: ExplorerSearch,
  search: { middlewares: [stripSearchParams(DEFAULTS)] },
  component: ExplorerPage,
});

const PRESETS = ["current_month", "current_quarter", "current_year", "ytd", "last_30_days", "last_90_days", "next_90_days"] as const;
const MEASURE_COLUMNS: Array<{ key: "budget" | "actual" | "projected" | "remaining" | "pace_index"; label: MessageKey }> = [
  { key: "budget", label: "explorer.col.budget" },
  { key: "actual", label: "explorer.col.actual" },
  { key: "projected", label: "explorer.col.projected" },
  { key: "remaining", label: "explorer.col.remaining" },
  { key: "pace_index", label: "explorer.col.pace" },
];

/** The design tokens (packages/ui/src/tokens.css) as Glide theme values: the canvas cannot read CSS variables. */
const GRID_THEME = {
  accentColor: "#1877f2",
  accentLight: "#f0f7ff",
  textDark: "#1b2638",
  textMedium: "#6b7a90",
  textLight: "#9facc0",
  textHeader: "#6b7a90",
  bgCell: "#ffffff",
  bgHeader: "#fafbfc",
  bgHeaderHovered: "#f3f6fa",
  borderColor: "#e6eaf0",
  horizontalBorderColor: "#eef1f5",
  headerFontStyle: "600 13px",
  baseFontStyle: "13px",
  fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
};

type Notice = { kind: "ok" | "error"; text: string } | { kind: "conflict"; name: string; amount: string };

function ExplorerPage(): ReactElement {
  const { ws } = Route.useParams();
  const search: ExplorerSearchT = Route.useSearch();
  const navigate = Route.useNavigate();
  const client = useQueryClient();
  const { data: dimensions = [] } = useQuery(registryQuery(ws));
  const { data: templates = [] } = useQuery(templatesQuery(ws));
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState<{ totals: Record<string, string | null>; total: number } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pasted, setPasted] = useState<BulkPreview | null>(null);

  const setSearch = (patch: Partial<ExplorerSearchT>) => void navigate({ search: (prev: ExplorerSearchT) => ({ ...prev, ...patch }), replace: false });
  const template = templates.find((x) => x.id === search.templateId) ?? templates.find((x) => x.isDefault) ?? templates[0];
  const view = search.view === "timeline" ? "tree" : search.view;
  const measures = useMemo(() => [...new Set([...MEASURE_COLUMNS.map((m) => m.key), ...search.measures])], [search.measures]);

  const labels = useMemo(() => {
    const m = new Map(dimensions.map((d) => [d.key, new Map(d.values.map((v) => [v.code, v.label]))]));
    return (dim: string, code: string) => m.get(dim)?.get(code) ?? code;
  }, [dimensions]);

  // A new source when what is queried changes; expanding a node updates the URL, not the source.
  const sourceKey = JSON.stringify([ws, view, search.filter, search.period, search.asOf ?? null, template?.path ?? [], search.groupBy, measures, reload]);
  const source = useMemo(
    () =>
      template || view === "pivot"
        ? new ExplorerRowSource(
            { ws, view, filter: search.filter, period: search.period, measures, asOf: search.asOf, levels: template?.path ?? [], groupBy: search.groupBy, expanded: search.expanded, sort: [] },
            labels,
            (keys) => void navigate({ search: (prev: ExplorerSearchT) => ({ ...prev, expanded: keys }), replace: true }),
            (s) => setLoaded({ totals: s.totals, total: s.total }),
          )
        : null,
    [sourceKey, labels],
  );

  const columns: ColumnSpec[] = useMemo(() => {
    const leading: ColumnSpec[] =
      view === "pivot" && search.groupBy.length
        ? search.groupBy.map((key): ColumnSpec => ({ kind: "dimension", key, title: dimensions.find((d) => d.key === key)?.label ?? key, width: 160 }))
        : [{ kind: "path", width: 340, title: t("explorer.col.name") }];
    return [
      ...leading,
      ...MEASURE_COLUMNS.map((m): ColumnSpec => ({ kind: "measure", key: m.key, title: t(m.label), width: m.key === "pace_index" ? 110 : 150, ...(m.key === "budget" ? { editable: true } : {}) })),
      { kind: "status", title: t("explorer.col.status"), width: 130 },
    ];
  }, [view, search.groupBy, dimensions]);

  const events: GridEvents = {
    onSelect: () => undefined,
    onOpen: (row) => {
      if (row.envelopeId && row.envelopeId !== search.select) setSearch({ select: row.envelopeId });
    },
    // A pasted range never writes cells: its Budget column becomes a bulk `paste` preview (T-013).
    onPaste: ({ anchor, cells }) => {
      const budgetCol = columns.findIndex((c) => c.kind === "measure" && c.key === "budget");
      const offset = budgetCol - anchor.col;
      const rows = cells.flatMap((line, i) => {
        const row = source?.rowAt(anchor.row + i);
        const amount = offset >= 0 ? parseMoney(line[offset] ?? "") : null;
        return row?.envelopeId && amount !== null ? [{ envelopeId: row.envelopeId, amount }] : [];
      });
      if (rows.length === 0) return setNotice({ kind: "error", text: t("paste.none") });
      void unwrap(
        api.POST("/api/v1/envelopes/bulk", {
          params: { header: { "X-Workspace-Id": ws } },
          body: { workspaceId: ws, selection: { envelopeIds: rows.map((r) => r.envelopeId) }, operation: { op: "paste", rows }, rationale: t("paste.rationaleDefault") } as never,
        }),
      )
        .then((preview) => setPasted(BulkPreview.parse(preview)))
        .catch((e: unknown) => setNotice({ kind: "error", text: t("explorer.error", { message: e instanceof Error ? e.message : String(e) }) }));
    },
    onEdit: async ({ row, value }) => {
      const r = row as ExplorerRow;
      if (!r.envelopeId) return setNotice({ kind: "error", text: t("explorer.edit.notEnvelope") });
      const amount = parseMoney(value);
      if (amount === null) return setNotice({ kind: "error", text: t("explorer.edit.invalid", { value }) });
      const res = await api.PATCH("/api/v1/envelopes/{id}/draft", {
        params: { path: { id: r.envelopeId }, header: { "X-Workspace-Id": ws } },
        body: { amount, basedOnVersionId: r.versionId ?? null } as never,
      });
      if (res.response.status === 409) {
        const current = await client.fetchQuery({ ...envelopeQuery(ws, r.envelopeId), staleTime: 0 });
        const head = current.draft ?? current.current;
        return setNotice({ kind: "conflict", name: current.name, amount: head ? formatMoney(head.amount, current.currency) : "—" });
      }
      if (!res.response.ok) {
        const e = (res.error ?? {}) as { message?: string };
        return setNotice({ kind: "error", text: t("explorer.error", { message: e.message ?? String(res.response.status) }) });
      }
      setNotice({ kind: "ok", text: t("explorer.edit.saved", { amount: formatMoney(amount, "USD") }) });
      await client.invalidateQueries({ queryKey: ["envelope", ws, r.envelopeId] });
      setReload((n) => n + 1);
    },
  };

  const toggle = "h-8 px-3 text-sm rounded-md";
  return (
    <Page title={t("nav.budgets")}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-border bg-card p-0.5" role="tablist" data-testid="view-toggle">
          {(["tree", "pivot"] as const).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} className={cn(toggle, view === v ? "bg-primary text-primary-foreground" : "text-foreground/80 hover:bg-accent")} onClick={() => setSearch({ view: v, expanded: [], select: undefined })} data-testid={`view-${v}`}>
              {t(v === "tree" ? "explorer.view.tree" : "explorer.view.pivot")}
            </button>
          ))}
        </div>
        {view === "tree" ? (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            {t("explorer.hierarchy")}
            <select className="h-8 rounded-md border border-input bg-card px-2 text-sm text-foreground" value={template?.id ?? ""} onChange={(e) => setSearch({ templateId: e.target.value, expanded: [] })} data-testid="template-picker">
              {templates.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground" data-testid="group-by">
            {t("explorer.groupBy")}
            {dimensions.map((d) => {
              const on = search.groupBy.includes(d.key);
              return (
                <button key={d.key} type="button" aria-pressed={on} className={cn("h-7 rounded-full border px-2.5 text-xs", on ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-foreground/80 hover:bg-accent")} onClick={() => setSearch({ groupBy: on ? search.groupBy.filter((k) => k !== d.key) : [...search.groupBy, d.key] })} data-testid={`group-${d.key}`}>
                  {d.label}
                </button>
              );
            })}
          </div>
        )}
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          {t("explorer.period")}
          <select className="h-8 rounded-md border border-input bg-card px-2 text-sm text-foreground" value={search.period.kind === "relative" ? search.period.preset : ""} onChange={(e) => setSearch({ period: { kind: "relative", preset: e.target.value as (typeof PRESETS)[number] } })} data-testid="period-picker">
            {search.period.kind === "relative" ? null : <option value="">{search.period.kind === "range" ? `${search.period.start} – ${search.period.end}` : search.period.key}</option>}
            {PRESETS.map((p) => (
              <option key={p} value={p}>
                {t(`explorer.period.${p}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <div className="ml-auto">
          <SavedViews ws={ws} current={search} onLoad={(v) => void navigate({ search: { ...(v.definition as Partial<ExplorerSearchT>), savedViewId: v.id } as ExplorerSearchT })} onSaved={(name) => setNotice({ kind: "ok", text: t("explorer.views.saved", { name }) })} />
        </div>
      </div>
      <FilterBar filter={search.filter} dimensions={dimensions} onChange={(filter: FilterGroupT) => setSearch({ filter, expanded: [] })} />
      {notice ? <NoticeBar notice={notice} onDismiss={() => setNotice(null)} onReload={() => (setNotice(null), setReload((n) => n + 1))} /> : null}
      <div className="flex min-h-0 gap-0">
        <div className="min-w-0 flex-1">
          <Card>
            <div className="h-[calc(100vh-19rem)] min-h-80" data-testid="explorer-grid" data-rows={loaded?.total ?? ""} data-budget-total={loaded?.totals["budget"] ?? ""}>
              {source ? <BudgetGrid key={sourceKey} source={source} columns={columns} events={events} totals={loaded?.totals ?? {}} currency="USD" theme={GRID_THEME} totalsLabel={t("explorer.totals")} /> : <p className="text-sm text-muted-foreground">{t("explorer.loading")}</p>}
            </div>
            <p className="pt-3 text-xs text-muted-foreground" data-testid="explorer-state">
              {loaded ? t("explorer.rows", { count: loaded.total }) : t("explorer.loading")} · {view} · {search.period.kind} · {search.measures.join(", ")}
            </p>
          </Card>
        </div>
        {pasted ? (
          <PasteDialog
            ws={ws}
            preview={pasted}
            onCancel={() => setPasted(null)}
            onDone={(count) => {
              setPasted(null);
              setNotice({ kind: "ok", text: t("paste.committed", { count }) });
              setReload((n) => n + 1);
            }}
          />
        ) : null}
        {search.select ? <EnvelopeDrawer ws={ws} id={search.select} onClose={() => setSearch({ select: undefined })} /> : null}
      </div>
    </Page>
  );
}

function NoticeBar({ notice, onDismiss, onReload }: { notice: Notice; onDismiss: () => void; onReload: () => void }): ReactElement {
  if (notice.kind === "conflict") {
    return (
      <div role="alert" className="flex items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm" data-testid="edit-conflict">
        <div className="flex-1">
          <p className="font-medium">{t("explorer.conflict.title")}</p>
          <p className="text-muted-foreground" data-testid="edit-conflict-body">
            {t("explorer.conflict.body", { name: notice.name, amount: notice.amount })}
          </p>
        </div>
        <Button size="sm" onClick={onReload} data-testid="edit-conflict-reload">
          {t("explorer.conflict.reload")}
        </Button>
      </div>
    );
  }
  return (
    <div role="status" className={cn("flex items-center gap-3 rounded-lg border px-4 py-2 text-sm", notice.kind === "ok" ? "border-success/40 bg-success/10" : "border-destructive/40 bg-destructive/10")} data-testid={notice.kind === "ok" ? "notice-ok" : "notice-error"}>
      <span className="flex-1">{notice.text}</span>
      <Button size="sm" variant="ghost" onClick={onDismiss}>
        {t("explorer.dismiss")}
      </Button>
    </div>
  );
}
