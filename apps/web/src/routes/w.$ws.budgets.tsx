import { BulkPreview, FilterGroup, Grain, PeriodSpec, type FilterGroupT } from "@budget/domain";
import { BudgetGrid, parseMoney, formatMoney, type ColumnSpec, type GridEvents } from "@budget/grid";
import { Button, cn } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { useRef, useMemo, useState, type ReactElement } from "react";
import { z } from "zod";
import { CheckSquare } from "lucide-react";
import { BulkTagBar } from "../features/explorer/bulk-tag.js";
import { tagsQuery } from "../features/threads/queries.js";
import { Card, Page } from "../components/page.js";
import { EnvelopeDrawer } from "../features/explorer/drawer.js";
import { FilterBar } from "../features/explorer/filter-bar.js";
import { PasteDialog } from "../features/explorer/paste-dialog.js";
import { STATUS_LABELS, useExplorerLabels } from "../features/explorer/labels.js";
import { SendForApproval } from "../features/explorer/send-for-approval.js";
import { FamilyEditor } from "../features/explorer/family-editor.js";
import { ExplorerRowSource, type ExplorerRow } from "../features/explorer/row-source.js";
import { SavedViews } from "../features/explorer/saved-views.js";
import { GRID_THEME } from "../features/explorer/grid-theme.js";
import { TimelineView } from "../features/timeline/TimelineView.js";
import { api, unwrap } from "../lib/api.js";
import { envelopeQuery, meQuery, periodsQuery, registryQuery, templatesQuery } from "../lib/queries.js";
import { NewBudgetDialog } from "../features/structure/new-budget-dialog.js";
import { StructureActions } from "../features/structure/structure-actions.js";
import { StructureDialog, type StructureOp } from "../features/structure/structure-dialog.js";
import { Plus } from "lucide-react";

/** Explorer search params are the source of truth for filter / grouping state (spec §18.1). */
const ExplorerSearch = z.object({
  filter: FilterGroup.default({ logic: "and", children: [] }),
  groupBy: z.array(z.string()).default([]),
  templateId: z.string().uuid().optional(),
  measures: z.array(z.string()).default(["budget", "actual", "projected", "pace_index"]),
  targets: z.array(z.string()).default([]),
  // The fiscal year, as the Overview: budgets are set for it, so Budget and pace read naturally.
  period: PeriodSpec.default({ kind: "relative", preset: "current_year" }),
  grain: Grain.default("total"),
  asOf: z.string().datetime().optional(),
  view: z.enum(["tree", "pivot", "timeline"]).default("tree"),
  zoom: z.enum(["week", "month", "quarter", "fy"]).default("month"),
  select: z.string().uuid().optional(),
  savedViewId: z.string().uuid().optional(),
  /** Expanded tree nodes (lz-string in the URL, spec §18.2). */
  expanded: z.array(z.string()).default([]),
  /** Opens the New budget dialog (Home's "Add your first budgets"). */
  new: z.boolean().optional(),
});
type ExplorerSearchT = z.infer<typeof ExplorerSearch>;

const DEFAULTS = { filter: { logic: "and" as const, children: [] }, groupBy: [], measures: ["budget", "actual", "projected", "pace_index"], targets: [], period: { kind: "relative" as const, preset: "current_year" as const }, grain: "total" as const, view: "tree" as const, zoom: "month" as const, expanded: [] };

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

type Notice = { kind: "ok" | "error"; text: string; requestId?: string; envelopeId?: string } | { kind: "conflict"; name: string; amount: string };

function ExplorerPage(): ReactElement {
  const { ws } = Route.useParams();
  const search: ExplorerSearchT = Route.useSearch();
  const navigate = Route.useNavigate();
  const client = useQueryClient();
  const { data: dimensions = [] } = useQuery(registryQuery(ws));
  const { data: templates = [] } = useQuery(templatesQuery(ws));
  const { data: periods = [] } = useQuery(periodsQuery(ws));
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState<{ totals: Record<string, string | null>; total: number } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // Select mode: tick rows, then tag or untag them together (product feedback 2026-09-28).
  const [selecting, setSelecting] = useState(false);
  const [ticked, setTicked] = useState<string[]>([]);
  const { data: tags = [] } = useQuery(tagsQuery(ws));
  const [pasted, setPasted] = useState<BulkPreview | null>(null);
  const [familyOf, setFamilyOf] = useState<string | null>(null);
  const [structure, setStructure] = useState<StructureOp | null>(null);
  const { data: selected } = useQuery({ ...envelopeQuery(ws, search.select ?? ""), enabled: search.select !== undefined });

  const setSearch = (patch: Partial<ExplorerSearchT>) => void navigate({ search: (prev: ExplorerSearchT) => ({ ...prev, ...patch }), replace: false });
  const { data: me } = useQuery(meQuery);
  const currency = me?.workspaces.find((w) => w.workspaceId === ws)?.currency ?? "USD";
  const template = templates.find((x) => x.id === search.templateId) ?? templates.find((x) => x.isDefault) ?? templates[0];
  const isTimeline = search.view === "timeline";
  // The timeline groups like the tree (hierarchy template); it has its own data source.
  const view = search.view === "timeline" ? "tree" : search.view;
  const measures = useMemo(() => [...new Set([...MEASURE_COLUMNS.map((m) => m.key), ...search.measures])], [search.measures]);

  const labels = useExplorerLabels(ws);

  // A new source when what is queried changes; expanding a node updates the URL, not the source.
  const sourceKey = JSON.stringify([ws, isTimeline, view, search.filter, search.period, search.asOf ?? null, template?.id ?? null, template?.path ?? [], search.groupBy, measures, reload]);
  const source = useMemo(
    () =>
      !isTimeline && (template || view === "pivot")
        ? new ExplorerRowSource(
            { ws, view, filter: search.filter, period: search.period, measures, asOf: search.asOf, templateId: template?.id, levels: template?.path ?? [], groupBy: search.groupBy, expanded: search.expanded, sort: [] },
            labels,
            (keys) => void navigate({ search: (prev: ExplorerSearchT) => ({ ...prev, expanded: keys }), replace: true }),
            // Only the current source reports: a replaced one (older filter) whose response lands
            // late must not overwrite the totals of the query now on screen.
            (s) => {
              if (s === currentSource.current) setLoaded({ totals: s.totals, total: s.total });
            },
          )
        : null,
    [sourceKey, labels],
  );
  const currentSource = useRef<ExplorerRowSource | null>(null);
  currentSource.current = source;

  const columns: ColumnSpec[] = useMemo(() => {
    const leading: ColumnSpec[] =
      view === "pivot" && search.groupBy.length
        ? search.groupBy.map((key): ColumnSpec => ({ kind: "dimension", key, title: dimensions.find((d) => d.key === key)?.label ?? key, width: 160 }))
        : [{ kind: "path", width: 340, title: t("explorer.col.name") }];
    return [
      ...leading,
      ...MEASURE_COLUMNS.map((m): ColumnSpec => ({ kind: "measure", key: m.key, title: t(m.label), width: m.key === "pace_index" ? 110 : 150, ...(m.key === "budget" ? { editable: true } : {}) })),
      { kind: "status", title: t("explorer.col.status"), width: 150, labels: STATUS_LABELS(), pendingLabel: (count: number) => t("status.groupPending", { count }) },
    ];
  }, [view, search.groupBy, dimensions]);

  const events: GridEvents = {
    onSelect: () => undefined,
    // A group row that is a budget (a parent) counts as that budget.
    onRowsSelected: (rows) => setTicked([...new Set(rows.map((r) => r.envelopeId ?? r.nodeEnvelopeId ?? null).filter((x): x is string => x !== null))]),
    onOpen: (row) => {
      // A leaf, or a parent budget from its group row (the envelope that is the group).
      const id = row.envelopeId ?? row.nodeEnvelopeId ?? null;
      if (id && id !== search.select) setSearch({ select: id });
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
      setNotice({ kind: "ok", text: t("explorer.edit.saved", { amount: formatMoney(amount, "USD") }), envelopeId: r.envelopeId });
      await client.invalidateQueries({ queryKey: ["envelope", ws, r.envelopeId] });
      setReload((n) => n + 1);
    },
  };

  const toggle = "h-8 px-3 text-sm rounded-md";
  return (
    <Page title={t("nav.budgets")}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-border bg-card p-0.5" role="tablist" data-testid="view-toggle" data-tour="view-toggle">
          {(["tree", "pivot", "timeline"] as const).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={search.view === v} className={cn(toggle, search.view === v ? "bg-primary text-primary-foreground" : "text-foreground/80 hover:bg-accent")} onClick={() => setSearch({ view: v, expanded: [], select: undefined })} data-testid={`view-${v}`}>
              {t(v === "tree" ? "explorer.view.tree" : v === "pivot" ? "explorer.view.pivot" : "explorer.view.timeline")}
            </button>
          ))}
        </div>
        <Button size="sm" onClick={() => setSearch({ new: true })} data-testid="new-budget" data-tour="new-budget">
          <Plus className="size-4" aria-hidden />
          {t("newBudget.button")}
        </Button>
        <StructureActions env={search.select ? (selected ?? null) : null} onPick={setStructure} />
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
          <select
            className="h-8 rounded-md border border-input bg-card px-2 text-sm text-foreground"
            value={search.period.kind === "relative" ? search.period.preset : search.period.kind === "fiscal" ? `fiscal:${search.period.key}` : ""}
            onChange={(e) => {
              const v = e.target.value;
              // The workspace's own periods (quarters as defined, custom partitions) next to the relative ones.
              setSearch({ period: v.startsWith("fiscal:") ? { kind: "fiscal", key: v.slice(7) } : { kind: "relative", preset: v as (typeof PRESETS)[number] } });
            }}
            data-testid="period-picker"
          >
            {search.period.kind === "relative" ? null : <option value="">{search.period.kind === "range" ? `${search.period.start} – ${search.period.end}` : search.period.key}</option>}
            {PRESETS.map((p) => (
              <option key={p} value={p}>
                {t(`explorer.period.${p}` as MessageKey)}
              </option>
            ))}
          
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
        {isTimeline ? (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            {t("timeline.zoom")}
            <select className="h-8 rounded-md border border-input bg-card px-2 text-sm text-foreground" value={search.zoom} onChange={(e) => setSearch({ zoom: e.target.value as ExplorerSearchT["zoom"] })} data-testid="zoom-picker">
              {(["week", "month", "quarter", "fy"] as const).map((z) => (
                <option key={z} value={z}>
                  {t(`timeline.zoom.${z}`)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="ml-auto">
          <SavedViews ws={ws} current={search} onLoad={(v) => void navigate({ search: { ...(v.definition as Partial<ExplorerSearchT>), savedViewId: v.id } as ExplorerSearchT })} onSaved={(name) => setNotice({ kind: "ok", text: t("explorer.views.saved", { name }) })} />
        </div>
      </div>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <FilterBar filter={search.filter} dimensions={dimensions} tags={tags} onChange={(filter: FilterGroupT) => setSearch({ filter, expanded: [] })} />
        </div>
        {search.view !== "timeline" ? (
          <Button size="sm" variant={selecting ? "default" : "outline"} aria-pressed={selecting} onClick={() => (setSelecting((v) => !v), setTicked([]))} data-testid="select-mode">
            <CheckSquare className="size-4" aria-hidden />
            {t("bulkTag.select")}
          </Button>
        ) : null}
      </div>
      {selecting && search.view !== "timeline" ? (
        <BulkTagBar
          ws={ws}
          envelopeIds={ticked}
          onDone={(text) => (setNotice({ kind: "ok", text }), setReload((n) => n + 1))}
          onExit={() => (setSelecting(false), setTicked([]))}
        />
      ) : null}
      {search.asOf ? (
        <div role="status" className="flex items-center gap-3 rounded-lg border border-primary/30 bg-secondary px-4 py-2 text-sm" data-testid="as-of-banner">
          <span className="flex-1">{t("timeline.asOfPast", { date: search.asOf.slice(0, 10) })}</span>
          <Button size="sm" variant="outline" onClick={() => setSearch({ asOf: undefined })} data-testid="as-of-now">
            {t("timeline.backToNow")}
          </Button>
        </div>
      ) : null}
      {notice ? <NoticeBar ws={ws} notice={notice} onDismiss={() => setNotice(null)} onReload={() => (setNotice(null), setReload((n) => n + 1))} onOpen={(id) => setSearch({ select: id })} /> : null}
      <div className="flex min-h-0 gap-0">
        <div className="min-w-0 flex-1">
          <Card>
            {isTimeline ? (
              <div className="h-[calc(100vh-19rem)] min-h-80">
                <TimelineView
                  ws={ws}
                  search={{ filter: search.filter, templateId: template?.id, period: search.period, asOf: search.asOf, zoom: search.zoom }}
                  currency="USD"
                  onSelect={(id) => setSearch({ select: id })}
                  onAsOf={(asOf) => setSearch({ asOf })}
                />
              </div>
            ) : (
              <>
                <div className="h-[calc(100vh-19rem)] min-h-80" data-testid="explorer-grid" data-rows={loaded?.total ?? ""} data-budget-total={loaded?.totals["budget"] ?? ""}>
                  {source ? <BudgetGrid key={sourceKey} source={source} columns={columns} events={events} totals={loaded?.totals ?? {}} currency="USD" theme={GRID_THEME} totalsLabel={t("explorer.totals")} selectRows={selecting} /> : <p className="text-sm text-muted-foreground">{t("explorer.loading")}</p>}
                </div>
                <p className="pt-3 text-xs text-muted-foreground" data-testid="explorer-state">
                  {loaded ? t("explorer.rows", { count: loaded.total }) : t("explorer.loading")} · {view} · {search.period.kind} · {search.measures.join(", ")}
                </p>
              </>
            )}
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
              void client.invalidateQueries({ queryKey: ["family"] });
              void client.invalidateQueries({ queryKey: ["envelope"] });
              setReload((n) => n + 1);
            }}
          />
        ) : null}
        {search.select ? <EnvelopeDrawer ws={ws} id={search.select} onClose={() => setSearch({ select: undefined })} onStructure={setStructure} onFamily={setFamilyOf} onChanged={() => setReload((n) => n + 1)} /> : null}
        {familyOf ? (
          <FamilyEditor
            ws={ws}
            id={familyOf}
            onClose={() => setFamilyOf(null)}
            onReview={(preview) => {
              setFamilyOf(null);
              setPasted(preview);
            }}
          />
        ) : null}
        {search.new ? (
          <NewBudgetDialog
            ws={ws}
            currency={currency}
            onCancel={() => setSearch({ new: undefined })}
            onCreated={(id) => {
              // The new budget opens in the drawer, where Send for approval is.
              setSearch({ new: undefined, select: id, view: "tree" });
              setReload((n) => n + 1);
            }}
          />
        ) : null}
        {structure && selected && selected.id === search.select ? (
          <StructureDialog
            ws={ws}
            op={structure}
            env={selected}
            onClose={() => setStructure(null)}
            onDone={(r) => {
              setStructure(null);
              const key = r.op === "move" ? "structure.done.move" : r.requestId ? "structure.done.request" : "structure.done.auto";
              setNotice({ kind: "ok", text: t(key, { name: selected.name }), ...(r.requestId ? { requestId: r.requestId } : {}) });
              setReload((n) => n + 1);
              void client.invalidateQueries({ queryKey: ["envelope", ws] });
              void client.invalidateQueries({ queryKey: ["approvals", ws] });
              void client.invalidateQueries({ queryKey: ["timeline", ws] });
            }}
          />
        ) : null}
      </div>
    </Page>
  );
}

function NoticeBar({ ws, notice, onDismiss, onReload, onOpen }: { ws: string; notice: Notice; onDismiss: () => void; onReload: () => void; onOpen?: (envelopeId: string) => void }): ReactElement {
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
      {notice.envelopeId ? <SendForApproval ws={ws} envelopeId={notice.envelopeId} compact /> : null}
      {notice.envelopeId && onOpen ? (
        <Button size="sm" variant="ghost" onClick={() => onOpen(notice.envelopeId as string)} data-testid="notice-open">
          {t("explorer.open")}
        </Button>
      ) : null}
      {notice.requestId ? (
        <Link to="/w/$ws/approvals/$id" params={{ ws, id: notice.requestId }} className="font-medium text-primary hover:underline" data-testid="notice-request">
          {t("structure.openRequest")}
        </Link>
      ) : null}
      <Button size="sm" variant="ghost" onClick={onDismiss}>
        {t("explorer.dismiss")}
      </Button>
    </div>
  );
}

