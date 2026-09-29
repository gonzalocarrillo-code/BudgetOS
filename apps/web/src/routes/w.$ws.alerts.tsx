import { Button, cn, Input, StatusChip, RowActions, toast } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { AlertOctagon, AlertTriangle, Database, Info } from "lucide-react";
import { useState, type ReactElement } from "react";
import { z } from "zod";
import { Card, Page } from "../components/page.js";
import { alertsQuery, can, type Alert } from "../features/ops/queries.js";
import { api, unwrap } from "../lib/api.js";
import { meQuery } from "../lib/queries.js";
import { appliedTagsQuery } from "../features/threads/queries.js";
import { TagChips } from "../features/threads/tag-chips.js";

/**
 * Alerts (spec §18.5, §11): what the pacing rules raised, newest first, by status and severity.
 * Each says which budget, which rule, the value against the threshold and the numbers behind it;
 * acknowledge, snooze for a week, or resolve. The rules live in Admin → Pacing rules.
 */
const TABS = ["OPEN", "ACKNOWLEDGED", "SNOOZED", "RESOLVED"] as const;
const SEVERITIES = ["critical", "warning", "info", "data"] as const;
const AlertsSearch = z.object({ status: z.enum(TABS).default("OPEN"), severity: z.enum(SEVERITIES).optional() });
type AlertsSearch = z.infer<typeof AlertsSearch>;

export const Route = createFileRoute("/w/$ws/alerts")({ validateSearch: AlertsSearch, component: AlertsPage });

const SEVERITY_ICON = { critical: AlertOctagon, warning: AlertTriangle, info: Info, data: Database } as const;
const COMPARATOR: Record<string, string> = { gt: ">", gte: "≥", lt: "<", lte: "≤" };

export function SeverityChip({ severity }: { severity: string }): ReactElement {
  return <StatusChip status={severity} icon={SEVERITY_ICON[severity as keyof typeof SEVERITY_ICON] ?? Info} label={t(`alerts.severity.${severity}` as MessageKey)} data-testid="severity-chip" />;
}

/** A metric value as people read it: ratios as percentages, the rest as numbers. */
export function metricText(metric: string | null, value: string): string {
  const n = Number(value);
  if (metric === "projected_variance_abs" || metric === "implied_volume_gap") return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (metric === "pace_index" || metric === "efficiency_adjusted_pace") return n.toFixed(2);
  return `${(n * 100).toFixed(1)}%`;
}

function AlertsPage(): ReactElement {
  const { ws } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const client = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const perms = me?.workspaces.find((w) => w.workspaceId === ws)?.permissions ?? [];
  const canAct = can(perms, me?.isOrgAdmin ?? false, "envelope.edit_draft");
  const { data: alerts = [], isPending, error } = useQuery(alertsQuery(ws, search.status, search.severity));
  // Every listed alert's tags in one request (chips on each row).
  const { data: alertTags = {} } = useQuery(appliedTagsQuery(ws, "alert", alerts.slice(0, 200).map((a) => a.id)));
  const set = (s: Partial<AlertsSearch>) => void navigate({ search: (prev: AlertsSearch) => ({ ...prev, ...s }) });
  const act = useMutation({
    meta: { success: t("toast.alertUpdated"), error: true },
    mutationFn: async ({ id, body }: { id: string; body: Record<string, unknown> }) => unwrap(api.PATCH("/api/v1/alerts/{id}", { params: { path: { id }, header: { "X-Workspace-Id": ws } }, body: body as never })),
    onSuccess: () => client.invalidateQueries({ queryKey: ["alerts", ws] }),
  });
  const weekFromNow = () => new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  // DS-004: tick alerts, then acknowledge, snooze or resolve them together.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const visibleIds = alerts.map((a) => a.id);
  const chosen = visibleIds.filter((id) => selected.has(id));
  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const bulk = useMutation({
    meta: { error: true },
    mutationFn: async (body: Record<string, unknown>) => {
      for (const id of chosen) await unwrap(api.PATCH("/api/v1/alerts/{id}", { params: { path: { id }, header: { "X-Workspace-Id": ws } }, body: body as never }));
      return chosen.length;
    },
    onSuccess: async (n) => {
      setSelected(new Set());
      await client.invalidateQueries({ queryKey: ["alerts", ws] });
      toast.success(t("alerts.bulkDone", { count: n }));
    },
  });

  return (
    <Page title={t("nav.alerts")} actions={<Link to="/w/$ws/admin/rules" params={{ ws }} className="text-sm text-primary hover:underline">{t("alerts.rules")}</Link>}>
      <div className="flex flex-wrap items-center gap-3">
        <div role="tablist" className="inline-flex rounded-lg border border-border bg-card p-0.5" data-testid="alerts-tabs">
          {TABS.map((s) => (
            <button key={s} type="button" role="tab" aria-selected={search.status === s} className={cn("h-8 rounded-md px-3 text-sm", search.status === s ? "bg-primary text-primary-foreground" : "text-foreground/80 hover:bg-accent")} onClick={() => set({ status: s })} data-testid={`alerts-tab-${s.toLowerCase()}`}>
              {t(`alerts.status.${s.toLowerCase()}` as MessageKey)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("alerts.severity")}>
          {[undefined, ...SEVERITIES].map((s) => (
            <button key={s ?? "all"} type="button" aria-pressed={search.severity === s} className={cn("h-7 rounded-full border px-2.5 text-xs", search.severity === s ? "border-primary bg-secondary" : "border-border hover:bg-accent")} onClick={() => set({ severity: s })} data-testid={`alerts-severity-${s ?? "all"}`}>
              {s ? t(`alerts.severity.${s}` as MessageKey) : t("alerts.severity.all")}
            </button>
          ))}
        </div>
      </div>
      <Card>
        {error ? <p role="alert" className="text-sm text-destructive">{error.message}</p> : null}
        {act.error ? <p role="alert" className="mb-2 text-sm text-destructive">{act.error.message}</p> : null}
        {isPending ? (
          <p className="text-sm text-muted-foreground">{t("shell.loading")}</p>
        ) : alerts.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="alerts-empty">{t("alerts.empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            {chosen.length > 0 ? (
              <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-secondary px-3 py-2 text-sm" role="region" aria-label={t("alerts.bulkLabel")} data-testid="alerts-bulk">
                <span className="font-medium">{t("alerts.selected", { count: chosen.length })}</span>
                <span className="flex-1" />
                {bulk.isPending ? (
                  <Button size="sm" disabled reason={t("shell.loading")}>{t("alerts.acknowledge")}</Button>
                ) : (
                  <>
                    <Button size="sm" variant="outline" onClick={() => bulk.mutate({ status: "ACKNOWLEDGED" })} data-testid="alerts-bulk-ack">{t("alerts.acknowledge")}</Button>
                    <Button size="sm" variant="outline" onClick={() => bulk.mutate({ status: "SNOOZED", snoozedUntil: weekFromNow() })} data-testid="alerts-bulk-snooze">{t("alerts.snooze")}</Button>
                    <Button size="sm" variant="outline" onClick={() => bulk.mutate({ status: "RESOLVED" })} data-testid="alerts-bulk-resolve">{t("alerts.resolve")}</Button>
                  </>
                )}
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>{t("alerts.clearSelection")}</Button>
              </div>
            ) : null}
            <table className="w-full text-sm" data-testid="alerts-table">
              <thead className="text-left text-muted-foreground">
                <tr>
                  {canAct ? (
                    <th className="w-8 py-2 pr-2">
                      <input type="checkbox" aria-label={t("alerts.selectAll")} checked={chosen.length > 0 && chosen.length === visibleIds.length} onChange={(e) => setSelected(e.target.checked ? new Set(visibleIds) : new Set())} data-testid="alerts-select-all" />
                    </th>
                  ) : null}
                  <th className="py-2 pr-3 font-medium">{t("alerts.col.severity")}</th>
                  <th className="py-2 pr-3 font-medium">{t("alerts.col.budget")}</th>
                  <th className="py-2 pr-3 font-medium">{t("alerts.col.rule")}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t("alerts.col.value")}</th>
                  <th className="py-2 pr-3 font-medium">{t("alerts.col.opened")}</th>
                  <th className="py-2 font-medium"><span className="sr-only">{t("alerts.col.actions")}</span></th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => (
                  <AlertRow key={a.id} ws={ws} a={a} tags={alertTags[a.id] ?? []} canAct={canAct} pending={act.isPending} onAct={(body) => act.mutate({ id: a.id, body })} weekFromNow={weekFromNow} selected={selected.has(a.id)} onToggle={() => toggle(a.id)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </Page>
  );
}

function AlertRow({ ws, a, tags, canAct, pending, onAct, weekFromNow, selected, onToggle }: { ws: string; a: Alert; tags: Array<{ id: string; name: string; color: string | null }>; canAct: boolean; pending: boolean; onAct: (body: Record<string, unknown>) => void; weekFromNow: () => string; selected: boolean; onToggle: () => void }): ReactElement {
  const ctx = a.context ?? {};
  // Reporting-currency amounts from the evaluator's context, as plain numbers.
  const money = (k: string) => (typeof ctx[k] === "string" ? Number(ctx[k]).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : null);
  const why = !canAct ? t("alerts.noPermission") : pending ? t("shell.loading") : null;
  const button = (label: MessageKey, body: Record<string, unknown>, testId: string, variant: "outline" | "ghost" = "outline") =>
    why ? (
      <Button key={testId} size="sm" variant={variant} disabled reason={why} data-testid={testId}>
        {t(label)}
      </Button>
    ) : (
      <Button key={testId} size="sm" variant={variant} onClick={() => onAct(body)} data-testid={testId}>
        {t(label)}
      </Button>
    );
  return (
    <tr className="group/row border-t border-border align-top hover:bg-accent/40 data-[selected=true]:bg-secondary" data-selected={selected} data-testid="alert-row">
      {canAct ? (
        <td className="py-2.5 pr-2">
          <input type="checkbox" checked={selected} onChange={onToggle} aria-label={t("alerts.selectOne", { name: a.envelopeName ?? a.envelopeId })} data-testid="alert-select" />
        </td>
      ) : null}
      <td className="py-2 pr-3">
        <SeverityChip severity={a.severity} />
      </td>
      <td className="py-2 pr-3">
        <Link to="/w/$ws/budgets" params={{ ws }} search={{ select: a.envelopeId } as never} className="font-medium hover:text-primary" data-testid="alert-budget">
          {a.envelopeName ?? a.envelopeId}
        </Link>
        {money("budget") ? <div className="tabular text-xs text-muted-foreground">{t("alerts.context", { budget: money("budget") ?? "—", actual: money("actual") ?? "—", projected: money("projected") ?? "—" })}</div> : null}
        <div className="mt-1">
          <TagChips ws={ws} entity={{ type: "alert", id: a.id }} tags={tags} compact />
        </div>
      </td>
      <td className="py-2 pr-3">{a.ruleName ?? "—"}</td>
      <td className="tabular whitespace-nowrap py-2 pr-3 text-right" data-testid="alert-value">
        {metricText(a.metric, a.metricValue)} <span className="text-muted-foreground">{COMPARATOR[a.comparator ?? ""] ?? ""} {metricText(a.metric, a.threshold)}</span>
      </td>
      <td className="whitespace-nowrap py-2 pr-3 text-muted-foreground">
        <time dateTime={a.openedAt}>{new Date(a.openedAt).toLocaleDateString()}</time>
        {a.snoozedUntil && a.status === "SNOOZED" ? (
          canAct && !pending ? (
            // ADR-060: the snooze date is editable; a new date re-snoozes the alert until the end of that day.
            <label className="mt-1 flex items-center gap-1 text-xs">
              {t("alerts.snoozedUntilLabel")}
              <Input
                type="date"
                className="h-7 w-36 text-xs"
                value={a.snoozedUntil.slice(0, 10)}
                min={new Date().toISOString().slice(0, 10)}
                onChange={(e) => {
                  if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) onAct({ status: "SNOOZED", snoozedUntil: `${e.target.value}T23:59:59.000Z` });
                }}
                data-testid="alert-snooze-until"
              />
            </label>
          ) : (
            <div className="text-xs">{t("alerts.snoozedUntil", { date: new Date(a.snoozedUntil).toLocaleDateString() })}</div>
          )
        ) : null}
      </td>
      <td className="py-2">
        <RowActions className="flex-wrap">
          {a.status === "OPEN" ? button("alerts.acknowledge", { status: "ACKNOWLEDGED" }, "alert-ack") : null}
          {a.status !== "RESOLVED" && a.status !== "SNOOZED" ? button("alerts.snooze", { status: "SNOOZED", snoozedUntil: weekFromNow() }, "alert-snooze", "ghost") : null}
          {a.status !== "RESOLVED" ? button("alerts.resolve", { status: "RESOLVED" }, "alert-resolve", "ghost") : null}
        </RowActions>
      </td>
    </tr>
  );
}
