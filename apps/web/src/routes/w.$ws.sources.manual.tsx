import type { ManualEntryIssue } from "@budget/domain";
import { BudgetGrid, formatMoney, type ColumnSpec, type GridEvents } from "@budget/grid";
import { Button, cn, Input, StatusChip, Select } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, Plus, Send } from "lucide-react";
import { useMemo, useRef, useState, type ReactElement } from "react";
import { z } from "zod";
import { Card, Page } from "../components/page.js";
import { GRID_THEME } from "../features/explorer/grid-theme.js";
import { EntrySource, FIELD } from "../features/manual-entry/entry-source.js";
import { Batch, batchQuery, batchesQuery, channelColor, type BatchSummary } from "../features/manual-entry/queries.js";
import { can } from "../features/ops/queries.js";
import { api, unwrap } from "../lib/api.js";
import { meQuery, registryQuery, type Dimension } from "../lib/queries.js";

/**
 * Manual results (spec §26, T-039): offline and non-integrated actuals — TV, OOH, print, radio… —
 * typed or pasted into a spreadsheet grid, tabbed by channel, with pinned totals, then sent for
 * approval. Every edit is saved as typed and validated by the server like ingestion; the send
 * button says why it is disabled ("2 rows have problems — row 3: unknown country "XX"").
 * Approved rows become facts; a batch never writes budgets.
 */
const ManualSearch = z.object({ channel: z.string().optional(), batch: z.string().uuid().optional(), cols: z.array(z.string()).optional() });
type ManualSearch = z.infer<typeof ManualSearch>;
export const Route = createFileRoute("/w/$ws/sources/manual")({ validateSearch: ManualSearch, component: ManualEntryPage });

const StatusBadge = ({ status }: { status: Batch["status"] }) => <StatusChip status={status} label={t(`manual.status.${status}` as MessageKey)} data-testid="batch-status" />;
const OFFLINE = ["tv", "ooh", "dooh", "print", "radio", "sponsorship", "other"];
const monthRange = (month: string) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { periodStart: `${month}-01`, periodEnd: end };
};

function ManualEntryPage(): ReactElement {
  const { ws } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const client = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const { data: dimensions = [] } = useQuery(registryQuery(ws));
  const channels = dimensions.find((d) => d.key === "channel")?.values.filter((v) => v.isActive !== false) ?? [];
  const channel = search.channel ?? channels.find((c) => c.code === "tv")?.code ?? channels[0]?.code ?? "";
  // Offline channels are the ones entered by hand: they get tabs (and the one open); the rest sit under "More channels".
  const rank = (code: string) => (OFFLINE.includes(code) ? OFFLINE.indexOf(code) : OFFLINE.length);
  const tabs = channels.filter((c) => OFFLINE.includes(c.code) || c.code === channel).sort((a, b) => rank(a.code) - rank(b.code));
  const more = channels.filter((c) => !tabs.includes(c));
  const { data: batches = [] } = useQuery({ ...batchesQuery(ws, channel), enabled: channel !== "" });
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const perms = me?.workspaces.find((w) => w.workspaceId === ws)?.permissions ?? [];
  const blocked = can(perms, me?.isOrgAdmin ?? false, "envelope.edit_draft") ? null : t("manual.noPermission");
  const setSearch = (patch: Partial<ManualSearch>) => void navigate({ search: (prev: ManualSearch) => ({ ...prev, ...patch }) });
  const selected = search.batch ?? batches[0]?.id;

  const create = useMutation({
    mutationFn: async () => z.object({ id: z.string() }).passthrough().parse(await unwrap(api.POST("/api/v1/workspaces/{ws}/manual-entries", { params: { path: { ws } }, body: { channel, ...monthRange(month), rows: [] } as never }))),
    onSuccess: async (b) => {
      await client.invalidateQueries({ queryKey: ["manual-entries", ws, channel] });
      setSearch({ batch: b.id });
    },
  });

  return (
    <Page title={t("page.manualEntry")}>
      <p className="-mt-2 max-w-3xl text-sm text-muted-foreground">{t("manual.intro")}</p>
      <div className="flex flex-wrap items-center gap-1 border-b border-border" data-testid="channel-tabs">
        <div role="tablist" aria-label={t("manual.channels")} className="flex flex-wrap items-center gap-1">
          {tabs.map((c) => (
            <button key={c.code} type="button" role="tab" aria-selected={c.code === channel} className={cn("-mb-px inline-flex h-10 items-center gap-2 border-b-2 px-3 text-sm", c.code === channel ? "border-primary font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")} onClick={() => setSearch({ channel: c.code, batch: undefined })} data-testid={`channel-${c.code}`}>
              <span className="size-2.5 rounded-full" style={{ background: channelColor(channels.indexOf(c)) }} aria-hidden />
              {c.label}
            </button>
          ))}
        </div>
        {more.length ? (
          <Select className="text-muted-foreground" wrapperClassName="mb-1 ml-auto" size="sm" value="" onChange={(e) => e.target.value && setSearch({ channel: e.target.value, batch: undefined })} aria-label={t("manual.moreChannels")} data-testid="channel-more">
            <option value="">{t("manual.moreChannels")}</option>
            {more.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </Select>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2" data-testid="batch-strip" data-tour="manual-batches">
        {batches.map((b) => (
          <BatchChip key={b.id} b={b} active={b.id === selected} onClick={() => setSearch({ batch: b.id })} />
        ))}
        <div className="ml-auto flex items-center gap-2">
          <Input type="month" className="w-40" value={month} onChange={(e) => setMonth(e.target.value)} aria-label={t("manual.month")} data-testid="batch-month" />
          {blocked || !channel ? (
            <Button disabled reason={blocked ?? t("manual.noChannel")} data-testid="batch-new">
              <Plus className="size-4" aria-hidden /> {t("manual.new")}
            </Button>
          ) : (
            <Button onClick={() => create.mutate()} data-testid="batch-new">
              <Plus className="size-4" aria-hidden /> {t("manual.new")}
            </Button>
          )}
        </div>
      </div>
      {create.error ? <p role="alert" className="text-sm text-destructive">{create.error.message}</p> : null}
      {selected ? (
        <BatchEditor key={selected} ws={ws} id={selected} dimensions={dimensions} cols={search.cols} blocked={blocked} onCols={(cols) => setSearch({ cols })} />
      ) : (
        <Card>
          <p className="py-8 text-center text-sm text-muted-foreground" data-testid="batch-empty">
            {t("manual.empty")}
          </p>
        </Card>
      )}
    </Page>
  );
}

function BatchChip({ b, active, onClick }: { b: BatchSummary; active: boolean; onClick: () => void }): ReactElement {
  return (
    <button type="button" onClick={onClick} className={cn("flex items-center gap-2 rounded-lg border px-3 py-1.5 text-left text-sm", active ? "border-primary bg-secondary" : "border-border bg-card hover:bg-accent")} data-testid="batch-chip" data-active={active}>
      <span className="font-medium tabular-nums">{b.periodStart.slice(0, 7)}</span>
      <StatusBadge status={b.status} />
      <span className="text-xs text-muted-foreground">{t("manual.rowsCount", { count: b.rowCount })}</span>
    </button>
  );
}

function BatchEditor({ ws, id, dimensions, cols, blocked, onCols }: { ws: string; id: string; dimensions: Dimension[]; cols: string[] | undefined; blocked: string | null; onCols: (cols: string[]) => void }): ReactElement {
  const client = useQueryClient();
  const { data: batch, error } = useQuery(batchQuery(ws, id));
  if (error) return <p role="alert" className="text-sm text-destructive">{error.message}</p>;
  if (!batch) return <p className="text-sm text-muted-foreground">{t("shell.loading")}</p>;
  return <BatchGrid key={`${batch.id}-${batch.status}`} ws={ws} batch={batch} dimensions={dimensions} cols={cols} blocked={blocked} onCols={onCols} onChanged={() => void client.invalidateQueries({ queryKey: ["manual-entries", ws] })} />;
}

function BatchGrid({ ws, batch, dimensions, cols, blocked, onCols, onChanged }: { ws: string; batch: Batch; dimensions: Dimension[]; cols: string[] | undefined; blocked: string | null; onCols: (cols: string[]) => void; onChanged: () => void }): ReactElement {
  const client = useQueryClient();
  const editable = batch.status === "DRAFT" && blocked === null;
  const source = useMemo(() => new EntrySource(batch.rows, editable, batch.issues), [batch.id, batch.status]);
  const [state, setState] = useState({ issues: batch.issues, warnings: batch.warnings, totals: batch.totals, saving: false, error: null as string | null });
  const edits = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Granularity columns: the URL's choice, else what the rows use (country when empty). Channel is the tab.
  const granular = dimensions.filter((d) => d.key !== "channel" && d.isActive !== false);
  const used = [...new Set(batch.rows.flatMap((r) => Object.keys(r.dimensionValues)))];
  const dimCols = (cols ?? (used.length ? used : ["country"])).filter((k) => granular.some((d) => d.key === k));
  const kpis = [...new Set(["conversions", ...batch.rows.flatMap((r) => Object.keys(r.kpis))])];
  const label = (key: string) => dimensions.find((d) => d.key === key)?.label ?? key;
  const fields = [...dimCols, FIELD.date, FIELD.currency, "amount", ...kpis.map(FIELD.kpi), FIELD.note];
  const columns: ColumnSpec[] = [
    { kind: "path", title: "#", width: 64 },
    ...dimCols.map((k): ColumnSpec => ({ kind: "dimension", key: k, title: label(k), width: 140, editable })),
    { kind: "dimension", key: FIELD.date, title: t("manual.col.date"), width: 120, editable },
    { kind: "dimension", key: FIELD.currency, title: t("manual.col.currency"), width: 90, editable },
    { kind: "measure", key: "actual", title: t("manual.col.amount"), width: 140, editable },
    ...kpis.map((k): ColumnSpec => ({ kind: "dimension", key: FIELD.kpi(k), title: k, width: 120, editable })),
    { kind: "dimension", key: FIELD.note, title: t("manual.col.note"), width: 220, editable },
  ];

  const save = useMutation({
    mutationFn: async () => {
      const startedAt = edits.current;
      const res = Batch.parse({ ...batch, ...((await unwrap(api.PATCH("/api/v1/manual-entries/{id}", { params: { path: { id: batch.id }, header: { "X-Workspace-Id": ws } }, body: { rows: source.value } as never }))) as unknown as Record<string, unknown>) });
      return { res, clean: edits.current === startedAt };
    },
    onSuccess: ({ res, clean }) => {
      if (clean) source.reset(res.rows);
      source.setIssues(res.issues);
      setState({ issues: res.issues, warnings: res.warnings, totals: res.totals, saving: false, error: null });
      client.setQueryData(["manual-entry", ws, batch.id], res);
      onChanged();
    },
    onError: (e) => setState((s) => ({ ...s, saving: false, error: e.message })),
  });
  const schedule = () => {
    edits.current += 1;
    setState((s) => ({ ...s, saving: true }));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => save.mutate(), 500);
  };
  const submit = useMutation({
    mutationFn: async () => unwrap(api.POST("/api/v1/manual-entries/{id}/submit", { params: { path: { id: batch.id }, header: { "X-Workspace-Id": ws } } })),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["manual-entry", ws, batch.id] });
      await client.invalidateQueries({ queryKey: ["approvals", ws] });
      onChanged();
    },
  });

  const events: GridEvents = {
    onSelect: () => undefined,
    onEdit: async ({ row, column, value }) => {
      if (!editable) return;
      const field = column.kind === "measure" ? "amount" : column.kind === "dimension" ? column.key : null;
      if (field === null) return;
      source.set(row.key, field, value);
      schedule();
    },
    // A pasted block fills the grid from the anchor (a draft batch: the server validates it on save).
    onPaste: ({ anchor, cells }) => {
      if (!editable) return;
      source.paste(anchor.row, fields.slice(Math.max(0, anchor.col - 1)), cells);
      schedule();
    },
  };
  const searchDimensionValues = async (key: string, q: string) => {
    if (key === FIELD.currency) return ["USD", "EUR", "GBP", "BRL", "MXN", "ARS"].filter((c) => c.startsWith(q.toUpperCase()));
    const dim = dimensions.find((d) => d.key === key);
    if (!dim) return [];
    const lower = q.toLowerCase();
    return dim.values.filter((v) => v.code.toLowerCase().startsWith(lower) || v.label.toLowerCase().startsWith(lower)).slice(0, 12).map((v) => v.code);
  };

  const rowsWithIssues = new Set(state.issues.map((i) => i.rowNo)).size;
  const first = state.issues[0];
  const reason =
    blocked ??
    (batch.status !== "DRAFT" ? t(`manual.reason.${batch.status}` as MessageKey)
    : state.saving || save.isPending ? t("manual.reason.saving")
    : state.totals.rows === 0 ? t("manual.reason.empty")
    : rowsWithIssues > 0 && first ? t("manual.reason.issues", { count: rowsWithIssues, row: first.rowNo, message: first.message })
    : submit.isPending ? t("shell.loading")
    : null);
  const decision = batch.lastRequest?.decision;

  return (
    <div className="flex flex-col gap-4" data-testid="batch-editor" data-batch={batch.id}>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <StatusBadge status={batch.status} />
        <span className="tabular-nums text-muted-foreground">
          {batch.periodStart} – {batch.periodEnd}
        </span>
        {state.saving || save.isPending ? <span className="text-xs text-muted-foreground" data-testid="batch-saving">{t("manual.saving")}</span> : <span className="text-xs text-muted-foreground" data-testid="batch-saved">{t("manual.saved")}</span>}
        {batch.approvalRequestId ? (
          <Link to="/w/$ws/approvals/$id" params={{ ws, id: batch.approvalRequestId }} className="text-primary hover:underline" data-testid="batch-request">
            {t("manual.openRequest")}
          </Link>
        ) : null}
      </div>
      {batch.status === "DRAFT" && batch.lastRequest && decision && batch.lastRequest.status !== "PENDING" ? (
        <div role="status" className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm" data-testid="batch-returned">
          <p className="font-medium">{t("manual.returned", { status: t(`manual.request.${batch.lastRequest.status}` as MessageKey) })}</p>
          {decision.comment ? <p className="text-muted-foreground">“{decision.comment}”</p> : null}
        </div>
      ) : null}
      {batch.status === "APPROVED" ? (
        <div role="status" className="flex items-center gap-2 rounded-lg border border-success/40 bg-success/10 px-4 py-3 text-sm" data-testid="batch-approved">
          <CheckCircle2 className="size-4 text-success" aria-hidden /> {t("manual.approved", { facts: batch.lineage?.length ?? 0 })}
        </div>
      ) : null}
      {editable ? (
        <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground" data-testid="granularity-picker">
          {t("manual.granularities")}
          {dimCols.map((k) => (
            <button key={k} type="button" aria-pressed className="h-7 rounded-full border border-primary bg-primary px-2.5 text-xs text-primary-foreground" onClick={() => onCols(dimCols.filter((x) => x !== k))} aria-label={t("manual.removeColumn", { name: label(k) })} data-testid={`col-${k}`}>
              {label(k)} ×
            </button>
          ))}
          <Select className="text-xs" size="sm" value="" onChange={(e) => e.target.value && onCols([...dimCols, e.target.value])} aria-label={t("manual.addColumn")} data-testid="col-add">
            <option value="">{t("manual.addColumn")}</option>
            {granular.filter((d) => !dimCols.includes(d.key)).map((d) => (
              <option key={d.key} value={d.key}>
                {d.label}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
      <Card>
        <div className="h-[26rem] min-w-0 overflow-hidden" data-testid="entry-grid" data-rows={state.totals.rows} data-total={state.totals.amount ?? ""}>
          <BudgetGrid key={`${source.value.length}-${dimCols.join()}`} source={source} columns={columns} events={events} totals={{ actual: state.totals.amount }} currency={Object.keys(state.totals.byCurrency)[0] ?? "USD"} theme={GRID_THEME} totalsLabel={t("manual.totals")} searchDimensionValues={searchDimensionValues} />
        </div>
      </Card>
      {state.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}
      <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
        <div className="flex flex-col gap-2">
          {state.issues.length ? <IssueList title={t("manual.issues", { count: rowsWithIssues })} issues={state.issues} tone="error" testId="batch-issues" /> : null}
          {state.warnings.length ? <IssueList title={t("manual.warnings", { count: state.warnings.length })} issues={state.warnings} tone="warn" testId="batch-warnings" /> : null}
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="text-right text-sm" data-testid="batch-totals">
            <span className="text-muted-foreground">{t("explorer.totals")}: </span>
            <span className="font-semibold tabular-nums">{Object.entries(state.totals.byCurrency).map(([c, v]) => formatMoney(v, c)).join(" + ") || "—"}</span>
          </div>
          {reason ? (
            <Button disabled reason={reason} data-testid="batch-submit">
              <Send className="size-4" aria-hidden /> {t("manual.submit")}
            </Button>
          ) : (
            <Button onClick={() => submit.mutate()} data-testid="batch-submit">
              <Send className="size-4" aria-hidden /> {t("manual.submit")}
            </Button>
          )}
          {reason && batch.status === "DRAFT" ? <p className="max-w-sm text-right text-xs text-muted-foreground" data-testid="batch-submit-reason">{reason}</p> : null}
          {submit.error ? <p role="alert" className="text-sm text-destructive">{submit.error.message}</p> : null}
        </div>
      </div>
    </div>
  );
}

function IssueList({ title, issues, tone, testId }: { title: string; issues: ManualEntryIssue[]; tone: "error" | "warn"; testId: string }): ReactElement {
  return (
    <div className={cn("rounded-lg border px-4 py-3 text-sm", tone === "error" ? "border-destructive/30 bg-destructive/5" : "border-warning/40 bg-warning/10")} data-testid={testId}>
      <p className="mb-1 flex items-center gap-2 font-medium">
        <AlertTriangle className={cn("size-4", tone === "error" ? "text-destructive" : "text-warning")} aria-hidden /> {title}
      </p>
      <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
        {issues.slice(0, 50).map((i) => (
          <li key={`${i.rowNo}-${i.field}`} className="text-muted-foreground" data-testid="issue">
            <span className="font-medium text-foreground">{t("manual.row", { row: i.rowNo })}</span> · {i.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
