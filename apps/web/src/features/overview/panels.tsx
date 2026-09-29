import type { OverviewResponse } from "@budget/domain";
import { Chip, StatusChip, cn } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, Clock, Database, Info, XCircle } from "lucide-react";
import type { ReactElement } from "react";
import { Card } from "../../components/page.js";
import { SeverityChip } from "../../routes/w.$ws.alerts.js";

/**
 * The Overview's lower panels (HO-014): alerts by rule (with a hint when one rule fires on most of
 * what it covers), CPA against target by market, the workspace's approval queue, and where the
 * numbers come from. Counts and order are the server's.
 */
const HEALTH_SHARE = 0.5;

export function AlertsByRule({ ws, o }: { ws: string; o: OverviewResponse }): ReactElement {
  const a = o.alerts;
  const rowLabel = o.heatmap?.rowDimension.label ?? "";
  const loud = a.byRule.filter((r) => r.covered !== null && r.covered > 0 && r.budgets / r.covered > HEALTH_SHARE);
  return (
    <Card title={t("overview.alertsByRule.title", { count: a.open })} tour="overview-alerts" testId="overview-alerts">
      {a.open === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">{t("overview.noAlerts")}</p>
      ) : (
        <div className="flex flex-col gap-3">
          <ul className="-my-1 flex flex-col divide-y divide-border text-sm">
            {a.byRule.map((r) => (
              <li key={r.ruleId} data-testid="alerts-rule">
                <Link to="/w/$ws/alerts" params={{ ws }} search={{ status: "OPEN", rule: r.ruleId } as never} className="flex items-center gap-2 py-2 hover:text-primary">
                  <SeverityChip severity={r.severity} />
                  <span className="min-w-0 flex-1 truncate">{r.ruleName ?? "—"}</span>
                  {r.byRow.length ? (
                    <span className="tabular hidden truncate text-xs text-muted-foreground sm:inline" data-testid="alerts-rule-rows">
                      {r.byRow.slice(0, 3).map((x) => `${x.code ?? "—"} ${x.count}`).join(" · ")}
                    </span>
                  ) : null}
                  <span className="tabular w-10 text-right font-semibold">{r.count}</span>
                </Link>
              </li>
            ))}
          </ul>
          {a.byRow.length && rowLabel ? (
            <p className="text-xs text-muted-foreground" data-testid="alerts-by-row">
              {t("overview.alertsByRule.byRow", { dimension: rowLabel })} {a.byRow.slice(0, 8).map((r) => `${r.code ?? "—"} ${r.count}`).join(" · ")}
            </p>
          ) : null}
          {loud.map((r) => (
            <p key={r.ruleId} className="flex items-start gap-2 rounded-lg bg-neutral-soft px-3 py-2 text-xs text-neutral-text" data-testid="alerts-rule-health">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                {t("overview.alertsByRule.health", { rule: r.ruleName ?? "—", budgets: r.budgets, covered: r.covered ?? 0 })}{" "}
                <Link to="/w/$ws/admin/rules" params={{ ws }} className="font-medium underline">
                  {t("overview.alertsByRule.rules")}
                </Link>
              </span>
            </p>
          ))}
          <Link to="/w/$ws/alerts" params={{ ws }} className="text-sm font-medium text-primary hover:underline">
            {t("overview.alertsByRule.open")} →
          </Link>
        </div>
      )}
    </Card>
  );
}

/** CPA against target by market: a bullet bar per row (the actual against the target mark), worst gap first. */
export function KpiPanel({ ws, kpi }: { ws: string; kpi: NonNullable<OverviewResponse["kpi"]> }): ReactElement {
  // The bar's scale: twice the target is the full width, so the target mark sits in the middle.
  return (
    <Card title={t("overview.kpi", { metric: kpi.metric.toUpperCase(), dimension: kpi.dimension.label })} tour="overview-kpi" actions={<span>{t("overview.kpiHelp")}</span>}>
      <table className="tabular w-full text-sm" data-testid="kpi-table">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className="py-1 pr-2 font-medium">{kpi.dimension.label}</th>
            <th className="w-1/3 py-1 pr-2 font-medium">
              <span className="sr-only">{t("overview.kpiActual")}</span>
            </th>
            <th className="py-1 pr-2 text-right font-medium">{t("overview.kpiActual")}</th>
            <th className="py-1 pr-2 text-right font-medium">{t("overview.kpiTarget")}</th>
            <th className="py-1 text-right font-medium">{t("overview.kpiGap")}</th>
          </tr>
        </thead>
        <tbody>
          {kpi.rows.map((r) => {
            const gap = r.vsTargetPct === null || r.vsTargetPct === undefined ? null : Number(r.vsTargetPct);
            const share = gap === null ? null : Math.max(0, Math.min(1, (1 + gap) / 2));
            const tone = gap === null ? "bg-subtle-foreground" : gap > 0.1 ? "bg-danger-text" : gap > 0 ? "bg-warning" : "bg-success";
            return (
              <tr key={r.code ?? "none"} className="border-t border-border" data-testid="kpi-row">
                <td className="max-w-40 truncate py-1.5 pr-2" title={r.label ?? r.code ?? "—"}>
                  {r.label ?? r.code ?? "—"}
                </td>
                <td className="py-1.5 pr-2">
                  <span className="relative block h-2 rounded-full bg-muted" role="img" aria-label={t("overview.cellLabel", { row: r.label ?? "", col: kpi.metric, spent: gap === null ? "—" : `${Math.round((1 + gap) * 100)}%`, budget: r.target ?? "—", actual: r.actual ?? "—" })}>
                    {share !== null ? <span className={cn("absolute inset-y-0 left-0 rounded-full", tone)} style={{ width: `${(share * 100).toFixed(1)}%` }} /> : null}
                    <span className="absolute -inset-y-1 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-foreground/70" aria-hidden />
                  </span>
                </td>
                <td className="py-1.5 pr-2 text-right">{r.actual ?? "—"}</td>
                <td className="py-1.5 pr-2 text-right">{r.target ?? "—"}</td>
                <td className={cn("py-1.5 text-right font-medium", gap === null ? "" : gap > 0 ? "text-danger-text" : "text-success-text")}>{gap === null ? "—" : `${gap > 0 ? "+" : ""}${(gap * 100).toFixed(1)}%`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-2">
        <Link to="/w/$ws/targets" params={{ ws }} className="text-sm font-medium text-primary hover:underline">
          {t("overview.kpi.targets")} →
        </Link>
      </div>
    </Card>
  );
}

export function QueuePanel({ ws, queue }: { ws: string; queue: NonNullable<OverviewResponse["queue"]> }): ReactElement {
  return (
    <Card title={t("overview.queue.title")} tour="overview-queue" testId="overview-approvals">
      {queue.waiting === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">{t("overview.queue.empty")}</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="tabular flex gap-6">
            <Stat value={String(queue.waiting)} label={t("overview.queue.waiting")} testId="queue-waiting" />
            <Stat value={String(queue.overdue)} label={t("overview.queue.overdue")} danger={queue.overdue > 0} testId="queue-overdue" />
            <Stat value={queue.oldestDays === null ? "—" : t("overview.queue.days", { n: queue.oldestDays })} label={t("overview.queue.oldest")} />
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">{t("overview.queue.byRole")}</span>
            {queue.byRole.map((r) => (
              <span key={r.role} className="flex items-center justify-between" data-testid="queue-role">
                <span>{t(`role.${r.role.toLowerCase()}` as MessageKey)}</span>
                <span className="tabular font-semibold">{r.count}</span>
              </span>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {queue.byKind.map((k) => (
              <Chip key={k.kind} tone="neutral">
                {t(`overview.queue.kind.${k.kind}` as MessageKey)} · {k.count}
              </Chip>
            ))}
          </div>
        </div>
      )}
      <div className="mt-2">
        <Link to="/w/$ws/approvals" params={{ ws }} search={{ tab: "open" } as never} className="text-sm font-medium text-primary hover:underline" data-testid="queue-open">
          {t("overview.queue.open")} →
        </Link>
      </div>
    </Card>
  );
}

function Stat({ value, label, danger = false, testId }: { value: string; label: string; danger?: boolean; testId?: string }): ReactElement {
  return (
    <span className="flex flex-col" data-testid={testId}>
      <span className={cn("text-2xl font-semibold tracking-[-0.02em]", danger && "text-danger-text")}>{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </span>
  );
}

/** Where the numbers come from, in one line (plan §11.1 "every derived number has its data_as_of"). */
export function DataFooter({ ws, o }: { ws: string; o: OverviewResponse }): ReactElement {
  const f = o.freshness;
  const through = o.asOf.through ? new Date(`${o.asOf.through}T00:00:00Z`).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-border bg-card px-4 py-2.5 text-xs text-muted-foreground shadow-xs" data-testid="overview-freshness" data-tour="overview-data">
      <Database className="size-4" aria-hidden />
      <span>{through ? t("asof.through", { date: through }) : t("overview.noFacts")}</span>
      {f.sources.map((s) => {
        const st = s.lastRun?.status;
        const Icon = st === "ok" ? CheckCircle2 : st === "failed" ? XCircle : Clock;
        return (
          <span key={s.id} className="flex items-center gap-1.5" data-testid="freshness-source">
            <Icon className={cn("size-3.5", st === "ok" ? "text-success-text" : st === "failed" ? "text-danger-text" : "")} aria-hidden />
            <span className="font-medium text-foreground">{s.name}</span>
            {s.lastRun ? (
              <span>
                {st ? <StatusChip status={st} className="h-5 px-2" /> : null} {new Date(s.lastRun.finishedAt ?? s.lastRun.startedAt).toLocaleString("en", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                {s.lastRun.matchCoverage ? ` · ${Math.round(Number(s.lastRun.matchCoverage) * 100)}%` : ""}
              </span>
            ) : (
              <span>{t("overview.neverRun")}</span>
            )}
          </span>
        );
      })}
      <span>{f.projections ? t("overview.data.projections", { date: new Date(f.projections.loadedAt).toLocaleDateString("en", { day: "numeric", month: "short" }) }) : t("overview.noProjections")}</span>
      <span>{t("overview.asOf", { at: new Date(o.dataAsOf).toLocaleString("en", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) })}</span>
      <Link to="/w/$ws/sources" params={{ ws }} className="ml-auto font-medium text-primary hover:underline">
        {t("overview.data.open")} →
      </Link>
    </div>
  );
}
