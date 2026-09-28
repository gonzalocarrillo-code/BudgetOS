import type { ExperimentReadout, FilterGroupT, MetricSet } from "@budget/domain";
import { formatMoney } from "@budget/grid";
import { Button, cn, StatusChip } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, CircleDashed, FlaskConical, XCircle } from "lucide-react";
import { useState, type ReactElement, type ReactNode } from "react";
import { z } from "zod";
import { FilterBar } from "../explorer/filter-bar.js";
import { api, unwrap } from "../../lib/api.js";
import type { Dimension } from "../../lib/queries.js";
import { KINDS, metricsQuery, type Experiment } from "./queries.js";

/**
 * Experiments UI pieces (spec §25): status and criterion badges, the side-by-side read-out, the
 * create form, the envelope link picker and the conclude dialog. Numbers come from the read-out
 * (the planner); nothing is computed here but the display.
 */

export function StatusBadge({ status }: { status: Experiment["status"] }): ReactElement {
  return <StatusChip status={status} label={t(`experiments.status.${status}` as MessageKey)} data-testid="experiment-status" />;
}

/** Met / not met / no verdict yet (and why). */
export function CriterionBadge({ experiment, readout }: { experiment: Experiment; readout: ExperimentReadout }): ReactElement {
  const c = experiment.criterion;
  const rule = t(c.vs === "control" ? `experiments.criterion.vsControl.${c.comparator}` : `experiments.criterion.absolute.${c.comparator}`, { metric: experiment.primaryMetric.toUpperCase(), value: c.value ?? "" });
  const waiting = readout.daysRunning < (c.minDays ?? 0);
  const [tone, icon, verdict] =
    readout.criterionMet === true
      ? ["border-success/40 bg-success/10 text-[#0b6b50]", <CheckCircle2 key="i" className="size-4" aria-hidden />, t("experiments.criterion.met")]
      : readout.criterionMet === false
        ? ["border-destructive/40 bg-destructive/10 text-destructive", <XCircle key="i" className="size-4" aria-hidden />, t("experiments.criterion.notMet")]
        : ["border-border bg-muted text-muted-foreground", <CircleDashed key="i" className="size-4" aria-hidden />, waiting ? t("experiments.criterion.waiting", { days: (c.minDays ?? 0) - readout.daysRunning }) : t("experiments.criterion.noData")];
  return (
    <div className={cn("inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm", tone)} data-testid="criterion-badge" data-met={readout.criterionMet === null ? "null" : String(readout.criterionMet)}>
      {icon}
      <span className="font-medium">{verdict}</span>
      <span className="opacity-80">· {rule}</span>
    </div>
  );
}

function Stat({ label, value, testId }: { label: string; value: ReactNode; testId?: string }): ReactElement {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-[15px] font-semibold tabular-nums" data-testid={testId}>
        {value}
      </span>
    </div>
  );
}

function SideCard({ side, title, set, metric, currency }: { side: "test" | "control"; title: string; set: MetricSet | null; metric: string; currency: string }): ReactElement {
  const spent = set && set.budget && set.actual && Number(set.budget) > 0 ? `${Math.round((Number(set.actual) / Number(set.budget)) * 100)}%` : "—";
  return (
    <div className={cn("flex-1 rounded-xl border bg-card p-5", side === "test" ? "border-primary/40" : "border-border")} data-testid={`readout-${side}`}>
      <div className="mb-4 flex items-center gap-2">
        <span className={cn("size-2.5 rounded-full", side === "test" ? "bg-primary" : "bg-subtle-foreground")} aria-hidden />
        <span className="text-sm font-semibold">{title}</span>
        {set ? <span className="ml-auto text-xs text-muted-foreground">{t("experiments.readout.leaves", { count: set.leafCount })}</span> : null}
      </div>
      {set ? (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          <Stat label={metric.toUpperCase()} value={set.metric === null ? "—" : Number(set.metric).toFixed(2)} testId={`readout-${side}-metric`} />
          <Stat label={t("explorer.col.budget")} value={set.budget ? formatMoney(set.budget, currency) : "—"} />
          <Stat label={t("explorer.col.actual")} value={set.actual ? formatMoney(set.actual, currency) : "—"} />
          <Stat label={t("timeline.col.spent")} value={spent} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("experiments.readout.noControl")}</p>
      )}
    </div>
  );
}

/** Test vs control side by side (spec §25.2), and the difference. */
export function ReadoutCards({ experiment, readout, currency }: { experiment: Experiment; readout: ExperimentReadout; currency: string }): ReactElement {
  const d = readout.delta;
  return (
    <div className="flex flex-col gap-3" data-testid="readout">
      <div className="flex flex-col gap-3 md:flex-row">
        <SideCard side="test" title={t("experiments.readout.test")} set={readout.test} metric={experiment.primaryMetric} currency={currency} />
        <SideCard side="control" title={experiment.criterion.vs === "absolute" ? t("experiments.readout.target", { value: experiment.criterion.value ?? "" }) : t("experiments.readout.control")} set={experiment.criterion.vs === "absolute" ? null : readout.control} metric={experiment.primaryMetric} currency={currency} />
      </div>
      <p className="text-sm text-muted-foreground" data-testid="readout-delta">
        {d
          ? t("experiments.readout.delta", { metric: experiment.primaryMetric.toUpperCase(), abs: `${Number(d.abs) >= 0 ? "+" : ""}${Number(d.abs).toFixed(2)}`, pct: d.pct === null ? "—" : `${Number(d.pct) >= 0 ? "+" : ""}${(Number(d.pct) * 100).toFixed(1)}%` })
          : t("experiments.readout.noDelta")}{" "}
        · {t("experiments.readout.days", { days: readout.daysRunning })}
      </p>
    </div>
  );
}

/** A modal shell in the style of the other dialogs. */
export function Dialog({ title, testId, onClose, children, footer }: { title: string; testId: string; onClose: () => void; children: ReactNode; footer: ReactNode }): ReactElement {
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-inverse/30 p-6" role="dialog" aria-modal="true" aria-label={title} onKeyDown={(e) => e.key === "Escape" && onClose()} data-testid={testId}>
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-card shadow-lg">
        <div className="border-b border-border px-5 py-4 text-[15px] font-semibold">{title}</div>
        <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">{children}</div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>
      </div>
    </div>
  );
}

const field = "h-9 w-full rounded-md border border-input bg-card px-3 text-sm outline-none focus:border-ring";
const Label = ({ text, children }: { text: string; children: ReactNode }) => (
  <label className="flex flex-col gap-1.5 text-sm">
    <span className="font-medium">{text}</span>
    {children}
  </label>
);

/** New experiment (spec §25.3): the question, the scopes, the metric and how success is judged. */
export function CreateExperimentDialog({ ws, dimensions, onClose, onCreated }: { ws: string; dimensions: Dimension[]; onClose: () => void; onCreated: (id: string) => void }): ReactElement {
  const { data: metrics = [] } = useQuery(metricsQuery(ws));
  const year = new Date().getUTCFullYear();
  const [f, setF] = useState({
    name: "",
    hypothesis: "",
    kind: "PLATFORM_TEST" as (typeof KINDS)[number],
    testFilter: { logic: "and", children: [] } as FilterGroupT,
    controlFilter: { logic: "and", children: [] } as FilterGroupT,
    primaryMetric: "cpa",
    comparator: "lte" as "lte" | "gte",
    vs: "control" as "control" | "absolute",
    value: "",
    minDays: "14",
    startDate: `${year}-01-01`,
    endDate: `${year}-03-31`,
  });
  const set = (patch: Partial<typeof f>) => setF((prev) => ({ ...prev, ...patch }));
  const create = useMutation({
    mutationFn: async () =>
      z.object({ id: z.string() }).passthrough().parse(
        await unwrap(
          api.POST("/api/v1/workspaces/{ws}/experiments", {
            params: { path: { ws } },
            body: {
              name: f.name,
              hypothesis: f.hypothesis,
              kind: f.kind,
              testFilter: f.testFilter,
              controlFilter: f.controlFilter.children.length ? f.controlFilter : null,
              primaryMetric: f.primaryMetric,
              criterion: { comparator: f.comparator, vs: f.vs, ...(f.vs === "absolute" ? { value: f.value } : {}), ...(f.minDays ? { minDays: Number(f.minDays) } : {}) },
              startDate: f.startDate,
              endDate: f.endDate,
            } as never,
          }),
        ),
      ),
    onSuccess: (x) => onCreated(x.id),
  });
  const why =
    !f.name.trim() ? t("experiments.form.needName")
    : !f.hypothesis.trim() ? t("experiments.form.needHypothesis")
    : f.testFilter.children.length === 0 ? t("experiments.form.needTest")
    : f.vs === "control" && f.controlFilter.children.length === 0 ? t("experiments.form.needControl")
    : f.vs === "absolute" && !/^-?\d+(\.\d{1,4})?$/.test(f.value) ? t("experiments.form.needValue")
    : f.startDate > f.endDate ? t("experiments.form.badDates")
    : create.isPending ? t("shell.loading")
    : null;
  return (
    <Dialog
      title={t("experiments.new")}
      testId="experiment-create"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("experiments.cancel")}
          </Button>
          {why ? (
            <Button disabled reason={why} data-testid="experiment-create-submit">
              {t("experiments.create")}
            </Button>
          ) : (
            <Button onClick={() => create.mutate()} data-testid="experiment-create-submit">
              {t("experiments.create")}
            </Button>
          )}
        </>
      }
    >
      <Label text={t("experiments.form.name")}>
        <input className={field} value={f.name} onChange={(e) => set({ name: e.target.value })} data-testid="experiment-name" />
      </Label>
      <Label text={t("experiments.form.hypothesis")}>
        <textarea className={cn(field, "h-20 py-2")} value={f.hypothesis} onChange={(e) => set({ hypothesis: e.target.value })} placeholder={t("experiments.form.hypothesisHint")} data-testid="experiment-hypothesis" />
      </Label>
      <div className="grid grid-cols-2 gap-3">
        <Label text={t("experiments.form.kind")}>
          <select className={field} value={f.kind} onChange={(e) => set({ kind: e.target.value as (typeof KINDS)[number] })} data-testid="experiment-kind">
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`experiments.kind.${k}` as MessageKey)}
              </option>
            ))}
          </select>
        </Label>
        <Label text={t("experiments.form.metric")}>
          <select className={field} value={f.primaryMetric} onChange={(e) => set({ primaryMetric: e.target.value })} data-testid="experiment-metric">
            {(metrics.length ? metrics : [{ key: "cpa", label: "CPA" }]).map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </Label>
      </div>
      <div className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">{t("experiments.form.testScope")}</span>
        <div data-testid="experiment-test-scope">
          <FilterBar filter={f.testFilter} dimensions={dimensions} onChange={(testFilter) => set({ testFilter })} />
        </div>
      </div>
      <div className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">{t("experiments.form.controlScope")}</span>
        <div data-testid="experiment-control-scope">
          <FilterBar filter={f.controlFilter} dimensions={dimensions} onChange={(controlFilter) => set({ controlFilter })} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Label text={t("experiments.form.success")}>
          <select className={field} value={`${f.vs}:${f.comparator}`} onChange={(e) => { const [vs, comparator] = e.target.value.split(":") as ["control" | "absolute", "lte" | "gte"]; set({ vs, comparator }); }} data-testid="experiment-criterion">
            {(["control:lte", "control:gte", "absolute:lte", "absolute:gte"] as const).map((v) => (
              <option key={v} value={v}>
                {t(`experiments.form.rule.${v.replace(":", ".")}` as MessageKey)}
              </option>
            ))}
          </select>
        </Label>
        {f.vs === "absolute" ? (
          <Label text={t("experiments.form.value")}>
            <input className={field} inputMode="decimal" value={f.value} onChange={(e) => set({ value: e.target.value })} data-testid="experiment-value" />
          </Label>
        ) : null}
        <Label text={t("experiments.form.minDays")}>
          <input className={field} inputMode="numeric" value={f.minDays} onChange={(e) => set({ minDays: e.target.value.replace(/\D/g, "") })} data-testid="experiment-min-days" />
        </Label>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Label text={t("experiments.form.start")}>
          <input type="date" className={field} value={f.startDate} onChange={(e) => set({ startDate: e.target.value })} data-testid="experiment-start" />
        </Label>
        <Label text={t("experiments.form.end")}>
          <input type="date" className={field} value={f.endDate} onChange={(e) => set({ endDate: e.target.value })} data-testid="experiment-end" />
        </Label>
      </div>
      {create.error ? <p role="alert" className="text-sm text-destructive">{create.error.message}</p> : null}
    </Dialog>
  );
}

/** Conclude (spec §25.3): the decision is required and is posted on every linked budget. */
export function ConcludeDialog({ ws, experiment, onClose, onDone }: { ws: string; experiment: Experiment; onClose: () => void; onDone: () => void }): ReactElement {
  const [decision, setDecision] = useState("");
  const conclude = useMutation({
    mutationFn: async () => unwrap(api.POST("/api/v1/experiments/{id}/conclude", { params: { path: { id: experiment.id }, header: { "X-Workspace-Id": ws } }, body: { decision } as never })),
    onSuccess: onDone,
  });
  const left = 20 - decision.trim().length;
  const why = left > 0 ? t("experiments.conclude.tooShort", { count: left }) : conclude.isPending ? t("shell.loading") : null;
  return (
    <Dialog
      title={t("experiments.conclude.title", { name: experiment.name })}
      testId="conclude-dialog"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("experiments.cancel")}
          </Button>
          {why ? (
            <Button disabled reason={why} data-testid="conclude-submit">
              {t("experiments.conclude.submit")}
            </Button>
          ) : (
            <Button onClick={() => conclude.mutate()} data-testid="conclude-submit">
              {t("experiments.conclude.submit")}
            </Button>
          )}
        </>
      }
    >
      <p className="text-sm text-muted-foreground">{t("experiments.conclude.help", { count: experiment.envelopes.length })}</p>
      <textarea className={cn(field, "h-32 py-2")} value={decision} onChange={(e) => setDecision(e.target.value)} placeholder={t("experiments.conclude.placeholder")} autoFocus data-testid="conclude-decision" />
      {conclude.error ? <p role="alert" className="text-sm text-destructive">{conclude.error.message}</p> : null}
    </Dialog>
  );
}

/** Link a budget from the test or control scope (a TEST link tags it `experiment`). */
export function LinkPicker({ ws, experiment, blocked, onLinked }: { ws: string; experiment: Experiment; blocked: string | null; onLinked: () => void }): ReactElement {
  const [role, setRole] = useState<"TEST" | "CONTROL">("TEST");
  const [envelopeId, setEnvelopeId] = useState("");
  const scope = role === "TEST" ? experiment.testFilter : experiment.controlFilter;
  const linked = new Set(experiment.envelopes.map((e) => e.envelopeId));
  const { data: candidates = [] } = useQuery({
    queryKey: ["experiment-candidates", ws, experiment.id, role],
    enabled: scope !== null && scope.children.length > 0,
    queryFn: async () => {
      const body = { workspaceId: ws, filter: { logic: "and", children: [{ field: { kind: "attr", key: "is_leaf" }, op: "eq", value: true }, ...(scope ? [scope] : [])] }, period: { kind: "range", start: experiment.startDate, end: experiment.endDate }, measures: ["budget"], sort: [{ key: "name", dir: "asc" }], limit: 200 };
      const res = z.object({ rows: z.array(z.object({ envelopeId: z.string().nullable(), path: z.array(z.string()) }).passthrough()) }).parse(await unwrap(api.POST("/api/v1/workspaces/{ws}/query", { params: { path: { ws } }, body: body as never })));
      return res.rows.filter((r) => r.envelopeId !== null).map((r) => ({ id: r.envelopeId as string, name: r.path.at(-1) ?? "" }));
    },
  });
  const link = useMutation({
    mutationFn: async () => unwrap(api.POST("/api/v1/experiments/{id}/link", { params: { path: { id: experiment.id }, header: { "X-Workspace-Id": ws } }, body: { envelopeId, role } as never })),
    onSuccess: () => (setEnvelopeId(""), onLinked()),
  });
  const options = candidates.filter((c) => !linked.has(c.id));
  const why = blocked ?? (!envelopeId ? t("experiments.link.pick") : link.isPending ? t("shell.loading") : null);
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="link-picker">
      <FlaskConical className="size-4 text-muted-foreground" aria-hidden />
      <select className="h-8 rounded-md border border-input bg-card px-2 text-sm" value={role} onChange={(e) => (setRole(e.target.value as "TEST" | "CONTROL"), setEnvelopeId(""))} data-testid="link-role">
        <option value="TEST">{t("experiments.role.TEST")}</option>
        <option value="CONTROL">{t("experiments.role.CONTROL")}</option>
      </select>
      <select className="h-8 min-w-64 max-w-md rounded-md border border-input bg-card px-2 text-sm" value={envelopeId} onChange={(e) => setEnvelopeId(e.target.value)} data-testid="link-envelope">
        <option value="">{options.length ? t("experiments.link.choose", { count: options.length }) : t("experiments.link.none")}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      {why ? (
        <Button size="sm" disabled reason={why} data-testid="link-submit">
          {t("experiments.link.submit")}
        </Button>
      ) : (
        <Button size="sm" onClick={() => link.mutate()} data-testid="link-submit">
          {t("experiments.link.submit")}
        </Button>
      )}
      {link.error ? <span role="alert" className="text-xs text-destructive">{link.error.message}</span> : null}
    </div>
  );
}
