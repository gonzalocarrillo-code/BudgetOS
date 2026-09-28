import { FilterGroup, type FilterGroupT } from "@budget/domain";
import { Button, cn, EmptyState, SkeletonRows } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Copy, Plus, Trash2, Gauge } from "lucide-react";
import { useState, type ReactElement, type ReactNode } from "react";
import { z } from "zod";
import { Card, Page } from "../components/page.js";
import { FilterBar } from "../features/explorer/filter-bar.js";
import { can, rulesQuery, type Rule } from "../features/ops/queries.js";
import { api, unwrap } from "../lib/api.js";
import { meQuery, periodsQuery, registryQuery } from "../lib/queries.js";
import { Person, tagsQuery } from "../features/threads/queries.js";
import { SeverityChip } from "./w.$ws.alerts.js";

/**
 * Pacing rules (spec §18.5 RuleEditor, §11): which metric, compared how, for how many days, on
 * which budgets (the same filter bar as the Explorer), how severe, and where it is delivered.
 * The pacing worker evaluates them daily; what they raise is on the Alerts screen.
 */
const RulesSearch = z.object({ edit: z.string().optional(), copy: z.string().uuid().optional() });
type RulesSearch = z.infer<typeof RulesSearch>;
export const Route = createFileRoute("/w/$ws/admin/rules")({ validateSearch: RulesSearch, component: RulesPage });

const METRICS = ["pace_index", "projected_close_pct", "spend_to_date_pct", "projected_variance_abs", "kpi_vs_target_pct", "implied_volume_gap", "efficiency_adjusted_pace"] as const;
const COMPARATORS = ["gt", "gte", "lt", "lte"] as const;
const SEVERITIES = ["critical", "warning", "info", "data"] as const;
const EMPTY: FilterGroupT = { logic: "and", children: [] };
const SYMBOL: Record<string, string> = { gt: ">", gte: "≥", lt: "<", lte: "≤" };
const PERIODS = ["current_year", "current_quarter", "current_month", "ytd", "last_30_days", "last_90_days"] as const;
type PeriodArg = { kind: "relative"; preset: string } | { kind: "fiscal"; key: string } | { kind: "range"; start: string; end: string };

function RulesPage(): ReactElement {
  const { ws } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: me } = useQuery(meQuery);
  const perms = me?.workspaces.find((w) => w.workspaceId === ws)?.permissions ?? [];
  const canManage = can(perms, me?.isOrgAdmin ?? false, "rule.manage");
  const { data: rules = [], isPending } = useQuery(rulesQuery(ws));
  const set = (s: Partial<RulesSearch>) => void navigate({ search: (prev: RulesSearch) => ({ ...prev, ...s }) });
  const editing = search.edit === "new" ? null : (rules.find((r) => r.id === search.edit) ?? null);
  // Duplicate: a new rule prefilled from another one.
  const template = search.edit === "new" && search.copy ? (rules.find((r) => r.id === search.copy) ?? null) : null;
  const blocked = canManage ? null : t("rules.noPermission");

  return (
    <Page
      title={t("admin.rules")}
      actions={
        blocked ? (
          <Button disabled reason={blocked} data-testid="rule-new">
            <Plus className="size-4" aria-hidden />
            {t("rules.new")}
          </Button>
        ) : (
          <Button onClick={() => set({ edit: "new", copy: undefined })} data-testid="rule-new">
            <Plus className="size-4" aria-hidden />
            {t("rules.new")}
          </Button>
        )
      }
    >
      <p className="-mt-2 text-sm text-muted-foreground">{t("rules.intro")}</p>
      <div className="grid gap-5 lg:grid-cols-[1fr_28rem]">
        <Card>
          {isPending ? (
            <SkeletonRows rows={5} />
          ) : rules.length === 0 ? (
            <EmptyState icon={Gauge} title={t("rules.empty.title")} body={t("rules.empty.body")} action={canManage ? <Button size="sm" onClick={() => set({ edit: "new", copy: undefined })}>{t("rules.new")}</Button> : undefined} />
          ) : (
            <table className="w-full text-sm" data-testid="rules-table">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 font-medium">{t("rules.col.name")}</th>
                  <th className="py-2 pr-3 font-medium">{t("rules.col.condition")}</th>
                  <th className="py-2 pr-3 font-medium">{t("rules.col.severity")}</th>
                  <th className="py-2 font-medium">{t("rules.col.active")}</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id} className={cn("cursor-pointer border-t border-border hover:bg-accent/50", search.edit === r.id ? "bg-secondary" : "", !r.isActive ? "text-muted-foreground" : "")} onClick={() => set({ edit: r.id })} data-testid="rule-row">
                    <td className="py-2 pr-3 font-medium">
                      <button type="button" className="text-left hover:text-primary" onClick={() => set({ edit: r.id })}>
                        {r.name}
                      </button>
                    </td>
                    <td className="py-2 pr-3">{condition(r)}</td>
                    <td className="py-2 pr-3">
                      <SeverityChip severity={r.severity} />
                    </td>
                    <td className="py-2">{t(r.isActive ? "rules.on" : "rules.off")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        {search.edit !== undefined ? (
          <Card title={editing ? t("rules.editTitle", { name: editing.name }) : template ? t("rules.copyTitle", { name: template.name }) : t("rules.new")}>
            <RuleEditor key={`${search.edit}-${search.copy ?? ""}`} ws={ws} rule={editing} from={template} blocked={blocked} onDone={() => set({ edit: undefined, copy: undefined })} onDuplicate={(id) => set({ edit: "new", copy: id })} />
          </Card>
        ) : null}
      </div>
    </Page>
  );
}

export const condition = (r: Pick<Rule, "metric" | "comparator" | "threshold" | "consecutiveDays">) =>
  `${t(`rules.metric.${r.metric}` as MessageKey)} ${SYMBOL[r.comparator] ?? r.comparator} ${r.threshold}${r.consecutiveDays > 1 ? ` · ${t("rules.forDays", { n: r.consecutiveDays })}` : ""}`;

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }): ReactElement {
  return (
    <label className="flex flex-col gap-1 text-sm font-medium">
      {label}
      {children}
      {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

function RuleEditor({ ws, rule, from, blocked, onDone, onDuplicate }: { ws: string; rule: Rule | null; from: Rule | null; blocked: string | null; onDone: () => void; onDuplicate: (id: string) => void }): ReactElement {
  const client = useQueryClient();
  const { data: dims = [] } = useQuery(registryQuery(ws));
  const { data: periods = [] } = useQuery(periodsQuery(ws));
  const { data: tags = [] } = useQuery(tagsQuery(ws));
  const { data: people = [] } = useQuery({
    queryKey: ["people", ws, "", 50],
    queryFn: async () => z.array(Person).parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/people", { params: { path: { ws }, query: { q: "", limit: 50 } as never } }))),
    staleTime: 30_000,
  });
  const base = rule ?? from;
  const args = (base?.metricArgs ?? {}) as { metricKey?: string; daysRemainingLt?: number; period?: PeriodArg };
  const [name, setName] = useState(rule?.name ?? (from ? t("rules.copyName", { name: from.name }) : ""));
  const [metric, setMetric] = useState<string>(base?.metric ?? "projected_close_pct");
  const [comparator, setComparator] = useState<string>(base?.comparator ?? "gt");
  const [threshold, setThreshold] = useState(base?.threshold ?? "1.1");
  const [days, setDays] = useState(String(base?.consecutiveDays ?? 1));
  const [severity, setSeverity] = useState<string>(base?.severity ?? "warning");
  const [metricKey, setMetricKey] = useState(args.metricKey ?? "cpa");
  const [daysLeft, setDaysLeft] = useState(args.daysRemainingLt ? String(args.daysRemainingLt) : "");
  // The span the metric is read over: default the fiscal year (what budgets are set for).
  const [period, setPeriod] = useState<string>(args.period === undefined ? "" : args.period.kind === "relative" ? args.period.preset : args.period.kind === "fiscal" ? `fiscal:${args.period.key}` : "");
  // A rule with no scope stores `{}` (the default rules do): that is "every budget".
  const stored = FilterGroup.safeParse(base?.scope);
  const [scope, setScope] = useState<FilterGroupT>(stored.success ? stored.data : EMPTY);
  const delivery = (base?.delivery ?? { inApp: true }) as { inApp?: boolean; slackChannel?: string; emails?: string[]; assignTo?: string };
  const [inApp, setInApp] = useState(delivery.inApp !== false);
  const [slack, setSlack] = useState(delivery.slackChannel ?? "");
  const [assignTo, setAssignTo] = useState(delivery.assignTo ?? "");
  const [active, setActive] = useState(rule?.isActive ?? true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const periodArg = (): PeriodArg | undefined => (period === "" ? undefined : period.startsWith("fiscal:") ? { kind: "fiscal", key: period.slice(7) } : { kind: "relative", preset: period });
  const body = () => ({
    name: name.trim(),
    scope,
    metric,
    metricArgs: { ...(metric === "kpi_vs_target_pct" ? { metricKey } : {}), ...(daysLeft ? { daysRemainingLt: Number(daysLeft) } : {}), ...(periodArg() ? { period: periodArg() } : {}) },
    comparator,
    threshold,
    consecutiveDays: Number(days),
    severity,
    // Emails are kept as they were (not delivered yet, so not offered here).
    delivery: { inApp, ...(slack.trim() ? { slackChannel: slack.trim() } : {}), ...(delivery.emails?.length ? { emails: delivery.emails } : {}), ...(assignTo ? { assignTo } : {}) },
    isActive: active,
  });
  const remove = useMutation({
    meta: { success: t("toast.ruleDeleted") },
    mutationFn: async () => unwrap(api.DELETE("/api/v1/rules/{id}", { params: { path: { id: rule?.id ?? "" }, header: { "X-Workspace-Id": ws } } })),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["rules", ws] });
      await client.invalidateQueries({ queryKey: ["alerts"] });
      onDone();
    },
  });
  const save = useMutation({
    meta: { success: t("toast.ruleSaved") },
    mutationFn: async () =>
      rule
        ? unwrap(api.PATCH("/api/v1/rules/{id}", { params: { path: { id: rule.id }, header: { "X-Workspace-Id": ws } }, body: body() as never }))
        : unwrap(api.POST("/api/v1/workspaces/{ws}/rules", { params: { path: { ws } }, body: body() as never })),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["rules", ws] });
      onDone();
    },
  });
  const invalid = !name.trim()
    ? t("rules.needName")
    : !/^-?\d{1,13}(\.\d{1,4})?$/.test(threshold)
      ? t("rules.badThreshold")
      : !/^\d+$/.test(days) || Number(days) < 1 || Number(days) > 90
        ? t("rules.badDays")
        : metric === "kpi_vs_target_pct" && !/^[a-z][a-z0-9_]{0,62}$/.test(metricKey)
          ? t("rules.needMetricKey")
          : null;
  const why = blocked ?? invalid ?? (save.isPending ? t("shell.loading") : null);
  const field = "h-9 rounded-lg border border-input bg-card px-2 text-sm outline-none focus:border-ring";
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!why) save.mutate();
      }}
      data-testid="rule-editor"
    >
      <Field label={t("rules.name")}>
        <input className={field} value={name} onChange={(e) => setName(e.target.value)} data-testid="rule-name" />
      </Field>
      <div className="grid grid-cols-[1fr_auto_7rem] gap-2">
        <Field label={t("rules.metric")}>
          <select className={field} value={metric} onChange={(e) => setMetric(e.target.value)} data-testid="rule-metric">
            {METRICS.map((m) => (
              <option key={m} value={m}>
                {t(`rules.metric.${m}` as MessageKey)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("rules.comparator")}>
          <select className={field} value={comparator} onChange={(e) => setComparator(e.target.value)} data-testid="rule-comparator">
            {COMPARATORS.map((c) => (
              <option key={c} value={c}>
                {SYMBOL[c]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("rules.threshold")}>
          <input className={cn(field, "text-right tabular")} inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} data-testid="rule-threshold" />
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">{t(`rules.metricHelp.${metric}` as MessageKey)}</p>
      {metric === "kpi_vs_target_pct" ? (
        <Field label={t("rules.metricKey")}>
          <input className={field} value={metricKey} onChange={(e) => setMetricKey(e.target.value)} />
        </Field>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("rules.days")} hint={t("rules.daysHelp")}>
          <input className={field} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} data-testid="rule-days" />
        </Field>
        <Field label={t("rules.daysLeft")} hint={t("rules.daysLeftHelp")}>
          <input className={field} inputMode="numeric" value={daysLeft} onChange={(e) => setDaysLeft(e.target.value.replace(/\D/g, ""))} />
        </Field>
      </div>
      <Field label={t("rules.period")} hint={t("rules.periodHelp")}>
        <select className={field} value={period} onChange={(e) => setPeriod(e.target.value)} data-testid="rule-period">
          <option value="">{t("rules.periodDefault")}</option>
          {PERIODS.filter((p) => p !== "current_year").map((p) => (
            <option key={p} value={p}>
              {t(`explorer.period.${p}` as MessageKey)}
            </option>
          ))}
          {periods.filter((p) => p.kind !== "month").length ? (
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
      </Field>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-sm font-medium">{t("rules.severity")}</legend>
        <div className="flex flex-wrap gap-1.5">
          {SEVERITIES.map((s) => (
            <button key={s} type="button" aria-pressed={severity === s} className={cn("rounded-full border px-1 py-0.5", severity === s ? "border-primary ring-2 ring-primary/30" : "border-transparent")} onClick={() => setSeverity(s)} data-testid={`rule-severity-${s}`}>
              <SeverityChip severity={s} />
            </button>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{t("rules.scope")}</p>
        <p className="text-xs text-muted-foreground">{t("rules.scopeHelp")}</p>
        <FilterBar filter={scope} dimensions={dims} tags={tags} onChange={setScope} />
      </div>
      <fieldset className="flex flex-col gap-2 rounded-lg border border-border p-3">
        <legend className="px-1 text-sm font-medium">{t("rules.delivery")}</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={inApp} onChange={(e) => setInApp(e.target.checked)} data-testid="rule-inapp" />
          {t("rules.inApp")}
        </label>
        <Field label={t("rules.slack")} hint={t("rules.slackHelp")}>
          <input className={field} value={slack} onChange={(e) => setSlack(e.target.value)} placeholder="#budget-alerts" data-testid="rule-slack" />
        </Field>
        <Field label={t("rules.assignTo")} hint={t("rules.assignToHelp")}>
          <select className={field} value={assignTo} onChange={(e) => setAssignTo(e.target.value)} data-testid="rule-assign">
            <option value="">{t("rules.assignOwner")}</option>
            {people
              .filter((p) => p.type === "user")
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.email ? ` · ${p.email}` : ""}
                </option>
              ))}
          </select>
        </Field>
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} data-testid="rule-active" />
        {t("rules.activeLabel")}
      </label>
      <p className="rounded-lg bg-surface px-3 py-2 text-xs text-muted-foreground" data-testid="rule-summary">
        {t("rules.summary", { condition: condition({ metric, comparator, threshold, consecutiveDays: Number(days) || 1 }), severity: t(`alerts.severity.${severity}` as MessageKey) })}
      </p>
      {save.error ? <p role="alert" className="text-sm text-destructive">{save.error.message}</p> : null}
      {remove.error ? <p role="alert" className="text-sm text-destructive">{remove.error.message}</p> : null}
      {rule && confirmDelete ? (
        <div className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm" role="alertdialog" data-testid="rule-delete-confirm">
          <p>{t("rules.deleteConfirm", { name: rule.name })}</p>
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>{t("threads.cancel")}</Button>
            {remove.isPending ? (
              <Button type="button" size="sm" variant="destructive" disabled reason={t("shell.loading")}>{t("rules.delete")}</Button>
            ) : (
              <Button type="button" size="sm" variant="destructive" onClick={() => remove.mutate()} data-testid="rule-delete-yes">{t("rules.delete")}</Button>
            )}
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        {rule ? (
          <>
            {blocked ? (
              <Button type="button" variant="ghost" disabled reason={blocked} className="mr-auto">
                <Trash2 className="size-4" aria-hidden />
                {t("rules.delete")}
              </Button>
            ) : (
              <Button type="button" variant="ghost" className="mr-auto text-destructive" onClick={() => setConfirmDelete(true)} data-testid="rule-delete">
                <Trash2 className="size-4" aria-hidden />
                {t("rules.delete")}
              </Button>
            )}
            {blocked ? (
              <Button type="button" variant="outline" disabled reason={blocked}>
                <Copy className="size-4" aria-hidden />
                {t("rules.duplicate")}
              </Button>
            ) : (
              <Button type="button" variant="outline" onClick={() => onDuplicate(rule.id)} data-testid="rule-duplicate">
                <Copy className="size-4" aria-hidden />
                {t("rules.duplicate")}
              </Button>
            )}
          </>
        ) : null}
        <Button type="button" variant="ghost" onClick={onDone}>
          {t("threads.cancel")}
        </Button>
        {why ? (
          <Button disabled reason={why} data-testid="rule-save">
            {t(rule ? "rules.save" : "rules.create")}
          </Button>
        ) : (
          <Button type="submit" data-testid="rule-save">
            {t(rule ? "rules.save" : "rules.create")}
          </Button>
        )}
      </div>
    </form>
  );
}
