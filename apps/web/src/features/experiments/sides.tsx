import type { ExperimentDay, ExperimentSide, ExperimentSides } from "@budget/domain";
import { formatMoney } from "@budget/grid";
import { Button, Input, Select, cn } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type ReactElement } from "react";
import { api, unwrap } from "../../lib/api.js";
import { Dialog } from "./components.js";
import { metricsQuery, type Experiment } from "./queries.js";

/**
 * EX-2 (ADR-086) / EX-4 (ADR-089): each side's facts from the read-out — side-by-side totals with a
 * metric chooser, a daily line chart with its own metric chooser and gaps where a side has no data,
 * and the day-by-day table (collapsed by default) that says "No data" for those days. Every number
 * comes from the API (the planner); this file only formats, chooses and draws it. The metric
 * selections live in the URL (owner feedback: "we should be able to choose what metrics we see").
 */

export interface Row {
  key: string;
  label: string;
  money: boolean;
  value: (side: ExperimentSide["totals"] | ExperimentDay) => string | null;
}

/** Spend, the KPI facts and the metric library's derived metrics, in that order (registry labels). */
export function useRows(ws: string, sides: ExperimentSides): Row[] {
  const { data: library = [] } = useQuery(metricsQuery(ws));
  const labels = new Map(library.map((m) => [m.key, m.label]));
  const derived = [...new Set([...Object.keys(sides.test.totals.metrics), ...Object.keys(sides.control?.totals.metrics ?? {})])];
  const kpis = [...new Set([...Object.keys(sides.test.totals.kpis), ...Object.keys(sides.control?.totals.kpis ?? {})])].filter((k) => !derived.includes(k));
  return [
    { key: "spend", label: t("experiments.sides.spend"), money: true, value: (s) => s.spend },
    ...kpis.map((k) => ({ key: `kpi:${k}`, label: labels.get(k) ?? k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), money: false, value: (s: ExperimentSide["totals"] | ExperimentDay) => s.kpis[k] ?? null })),
    ...derived.map((k) => ({ key: k, label: labels.get(k) ?? k.toUpperCase(), money: false, value: (s: ExperimentSide["totals"] | ExperimentDay) => s.metrics[k] ?? null })),
  ];
}

const show = (row: Row, v: string | null, currency: string) => (v === null ? "—" : row.money ? formatMoney(v, currency) : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }));

/** A row of toggleable chips: the multi-select metric chooser (owner feedback, EX-4). */
function MetricChooser({ rows, selected, onChange, testId }: { rows: Row[]; selected: string[]; onChange: (keys: string[]) => void; testId: string }): ReactElement {
  const toggle = (key: string) => {
    const next = selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key];
    onChange(next.length ? next : [key]); // at least one metric stays selected
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("experiments.sides.chooseMetrics")} data-testid={testId}>
      {rows.map((r) => {
        const on = selected.includes(r.key);
        return (
          <button
            key={r.key}
            type="button"
            aria-pressed={on}
            className={cn("h-7 rounded-full border px-2.5 text-xs", on ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-foreground/80 hover:bg-accent")}
            onClick={() => toggle(r.key)}
            data-testid={`${testId}-${r.key}`}
          >
            {r.label}
          </button>
        );
      })}
    </div>
  );
}

export function SidesPanel({
  ws,
  experiment,
  sides,
  currency,
  metrics,
  onMetricsChange,
  chartMetric,
  onChartMetricChange,
}: {
  ws: string;
  experiment: Experiment;
  sides: ExperimentSides;
  currency: string;
  /** Table metric chooser (URL `metrics`); defaults to spend + the primary metric. */
  metrics: string[] | undefined;
  onMetricsChange: (keys: string[]) => void;
  /** Chart metric chooser (URL `chartMetric`); defaults to the primary metric. */
  chartMetric: string | undefined;
  onChartMetricChange: (key: string) => void;
}): ReactElement {
  const allRows = useRows(ws, sides);
  const selected = metrics && metrics.length ? metrics : ["spend", experiment.primaryMetric];
  const rows = allRows.filter((r) => selected.includes(r.key));
  const chartKey = chartMetric ?? experiment.primaryMetric;
  const chartRow = allRows.find((r) => r.key === chartKey) ?? allRows.find((r) => r.key === experiment.primaryMetric) ?? allRows[0];
  const days = sides.test.totals.daysInWindow;
  const scope = (s: ExperimentSide) => t(s.scopeKind === "fact" ? "experiments.sides.scope.fact" : "experiments.sides.scope.envelope");
  return (
    <div className="flex flex-col gap-4" data-testid="experiment-sides" data-tour="experiment-sides">
      <MetricChooser rows={allRows} selected={selected} onChange={onMetricsChange} testId="sides-metric-chooser" />
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="sides-table">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-2 font-medium">{t("experiments.sides.metric")}</th>
              <th className="py-2 text-right font-medium">
                {t("experiments.readout.test")} <span className="font-normal">· {scope(sides.test)}</span>
              </th>
              {sides.control ? (
                <th className="py-2 text-right font-medium">
                  {t("experiments.readout.control")} <span className="font-normal">· {scope(sides.control)}</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={cn("border-t border-border", r.key === experiment.primaryMetric && "font-semibold")} data-testid={`sides-row-${r.key}`}>
                <td className="py-2 pr-3">{r.label}</td>
                <td className="py-2 text-right tabular-nums" data-testid={`sides-test-${r.key}`}>
                  {show(r, r.value(sides.test.totals), currency)}
                </td>
                {sides.control ? (
                  <td className="py-2 text-right tabular-nums" data-testid={`sides-control-${r.key}`}>
                    {show(r, r.value(sides.control.totals), currency)}
                  </td>
                ) : null}
              </tr>
            ))}
            <tr className="border-t border-border text-muted-foreground">
              <td className="py-2 pr-3">{t("experiments.sides.coverage")}</td>
              <td className="py-2 text-right tabular-nums" data-testid="sides-test-coverage">
                {t("experiments.sides.coverageValue", { with: sides.test.totals.daysWithData, total: sides.test.totals.daysInWindow })}
              </td>
              {sides.control ? (
                <td className="py-2 text-right tabular-nums" data-testid="sides-control-coverage">
                  {t("experiments.sides.coverageValue", { with: sides.control.totals.daysWithData, total: sides.control.totals.daysInWindow })}
                </td>
              ) : null}
            </tr>
          </tbody>
        </table>
        <p className="mt-2 text-xs text-muted-foreground">{t("experiments.sides.weighted")}</p>
      </div>
      {days === 0 || chartRow === undefined ? (
        <p className="text-sm text-muted-foreground" data-testid="sides-not-started">
          {t("experiments.sides.notStarted")}
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-2" data-tour="experiment-chart">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{t("experiments.chart.metric")}</span>
              <Select size="sm" value={chartRow.key} onChange={(e) => onChartMetricChange(e.target.value)} data-testid="chart-metric">
                {allRows.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </Select>
              <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
                <Legend tone="text-primary" label={t("experiments.readout.test")} />
                {sides.control ? <Legend tone="text-subtle-foreground" label={t("experiments.readout.control")} dashed /> : null}
                <span>{t("experiments.chart.gaps")}</span>
              </span>
            </div>
            <LineChart row={chartRow} test={sides.test.days} control={sides.control?.days ?? null} />
          </div>
          <DayTable spendRow={allRows.find((r) => r.key === "spend") as Row} chartRow={chartRow} sides={sides} currency={currency} />
        </>
      )}
    </div>
  );
}

function Legend({ tone, label, dashed = false }: { tone: string; label: string; dashed?: boolean }): ReactElement {
  return (
    <span className="inline-flex items-center gap-1">
      <svg width="18" height="6" aria-hidden className={tone}>
        <line x1="0" y1="3" x2="18" y2="3" stroke="currentColor" strokeWidth="2" strokeDasharray={dashed ? "4 3" : undefined} />
      </svg>
      {label}
    </span>
  );
}

const W = 720;
const H = 200;
const PAD = { l: 8, r: 8, t: 10, b: 22 };

/** Runs of consecutive days with a value: a no-data day breaks the line (never drawn as 0). */
function runs(values: Array<number | null>): Array<Array<[number, number]>> {
  const out: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (cur.length) out.push(cur);
      cur = [];
    } else cur.push([i, v]);
  });
  if (cur.length) out.push(cur);
  return out;
}

/** A daily line per side, with gaps for the days without data. Plain SVG: apps/web has no chart library. */
function LineChart({ row, test, control }: { row: Row; test: ExperimentDay[]; control: ExperimentDay[] | null }): ReactElement {
  const series = [
    { name: "test", tone: "text-primary", dash: undefined, values: test.map((d) => (d.hasData ? row.value(d) : null)).map((v) => (v === null ? null : Number(v))) },
    ...(control ? [{ name: "control", tone: "text-subtle-foreground", dash: "5 4", values: control.map((d) => (d.hasData ? row.value(d) : null)).map((v) => (v === null ? null : Number(v))) }] : []),
  ];
  const all = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const max = all.length ? Math.max(...all, 0) : 1;
  const min = all.length ? Math.min(...all, 0) : 0;
  const span = max - min || 1;
  const n = Math.max(test.length, 1);
  const x = (i: number) => PAD.l + (n === 1 ? (W - PAD.l - PAD.r) / 2 : (i / (n - 1)) * (W - PAD.l - PAD.r));
  const y = (v: number) => PAD.t + (1 - (v - min) / span) * (H - PAD.t - PAD.b);
  const first = test[0]?.date ?? "";
  const last = test[test.length - 1]?.date ?? "";
  return (
    <figure className="m-0 rounded-lg border border-border bg-card p-2" data-testid="experiment-chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-52 w-full" role="img" aria-label={t("experiments.chart.label", { metric: row.label })}>
        <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} className="text-border" stroke="currentColor" strokeWidth="1" />
        {series.map((s) =>
          runs(s.values).map((run, j) =>
            run.length === 1 ? (
              <circle key={`${s.name}-${j}`} cx={x(run[0]?.[0] ?? 0)} cy={y(run[0]?.[1] ?? 0)} r="2.5" className={s.tone} fill="currentColor" data-testid={`chart-${s.name}-point`} />
            ) : (
              <polyline key={`${s.name}-${j}`} points={run.map(([i, v]) => `${x(i)},${y(v)}`).join(" ")} className={s.tone} fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray={s.dash} strokeLinejoin="round" data-testid={`chart-${s.name}-run`} />
            ),
          ),
        )}
        <text x={PAD.l} y={H - 6} className="fill-muted-foreground text-[11px]">
          {first}
        </text>
        <text x={W - PAD.r} y={H - 6} textAnchor="end" className="fill-muted-foreground text-[11px]">
          {last}
        </text>
      </svg>
    </figure>
  );
}

/** Every day of the window: spend and the charted metric per side; "No data" where a side has none. */
function DayTable({ spendRow, chartRow, sides, currency }: { spendRow: Row; chartRow: Row; sides: ExperimentSides; currency: string }): ReactElement {
  const cols = chartRow.key === "spend" ? [spendRow] : [spendRow, chartRow];
  const cell = (d: ExperimentDay | undefined, testId: string) =>
    d === undefined || !d.hasData ? (
      <td colSpan={cols.length} className="py-1.5 text-right text-muted-foreground" data-testid={testId} data-has-data="false">
        {t("experiments.days.noData")}
      </td>
    ) : (
      cols.map((c) => (
        <td key={c.key} className="py-1.5 text-right tabular-nums" data-testid={c.key === "spend" ? testId : undefined} data-has-data="true">
          {show(c, c.value(d), currency)}
        </td>
      ))
    );
  return (
    <details className="rounded-lg border border-border" data-testid="experiment-days">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{t("experiments.days.title")}</summary>
      <div className="max-h-80 overflow-auto px-3 pb-2">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-card">
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-1.5 font-medium">{t("experiments.days.date")}</th>
              {cols.map((c) => (
                <th key={`t-${c.key}`} className="py-1.5 text-right font-medium">
                  {t("experiments.readout.test")} · {c.label}
                </th>
              ))}
              {sides.control
                ? cols.map((c) => (
                    <th key={`c-${c.key}`} className="py-1.5 text-right font-medium">
                      {t("experiments.readout.control")} · {c.label}
                    </th>
                  ))
                : null}
            </tr>
          </thead>
          <tbody>
            {sides.test.days.map((d, i) => (
              <tr key={d.date} className="border-t border-border" data-testid="day-row" data-date={d.date}>
                <td className="py-1.5 pr-3 tabular-nums">{d.date}</td>
                {cell(d, "day-test")}
                {sides.control ? cell(sides.control.days[i], "day-control") : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/**
 * EX-2: permanent delete. The experiment's exact name must be typed; the dialog says it cannot be
 * recovered. The API checks owner-or-admin again.
 */
export function DeleteExperimentDialog({ ws, experiment, onClose, onDeleted }: { ws: string; experiment: Experiment; onClose: () => void; onDeleted: () => void }): ReactElement {
  const [typed, setTyped] = useState("");
  const remove = useMutation({
    mutationFn: async () => unwrap(api.DELETE("/api/v1/experiments/{id}", { params: { path: { id: experiment.id }, header: { "X-Workspace-Id": ws } } })),
    onSuccess: onDeleted,
  });
  const why = typed.trim() !== experiment.name.trim() ? t("experiments.delete.mismatch") : remove.isPending ? t("shell.loading") : null;
  return (
    <Dialog
      title={t("experiments.delete.title", { name: experiment.name })}
      testId="delete-dialog"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("experiments.cancel")}
          </Button>
          {why ? (
            <Button variant="destructive" disabled reason={why} data-testid="delete-submit">
              {t("experiments.delete.submit")}
            </Button>
          ) : (
            <Button variant="destructive" onClick={() => remove.mutate()} data-testid="delete-submit">
              {t("experiments.delete.submit")}
            </Button>
          )}
        </>
      }
    >
      <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="delete-warning">
        {t("experiments.delete.warning")}
      </p>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">{t("experiments.delete.typeName")}</span>
        <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={experiment.name} autoFocus autoComplete="off" data-testid="delete-confirm-name" />
      </label>
      {remove.error ? <p role="alert" className="text-sm text-destructive">{remove.error.message}</p> : null}
    </Dialog>
  );
}
