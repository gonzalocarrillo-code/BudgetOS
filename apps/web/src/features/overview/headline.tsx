import { paceBand, type OverviewResponse } from "@budget/domain";
import { formatChange, formatMoney, formatMoneyCompact, formatPctChange } from "@budget/grid";
import { PaceBar, StatTile } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { Link } from "@tanstack/react-router";
import type { ReactElement } from "react";

/**
 * The headline (HO-012, docs/HOME_OVERVIEW_PLAN.md §3.2): four tiles about money. Budget, with the
 * share split into budgets below (ADR-051) and the change since the snapshot compared with; Spent,
 * with the pace bar read as of the data (ADR-062); Remaining, with the days left and the daily rate
 * that spends it (a division, not a forecast); Projected close only when projections are loaded.
 */
export type HeadlineTile = "headline.budget" | "headline.spent" | "headline.remaining" | "headline.projected";

const pct = (v: string | null | undefined) => (v === null || v === undefined ? "—" : `${Math.round(Number(v) * 100)}%`);
const num = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" });

export function Headline({ ws, o, shows, periodLabel }: { ws: string; o: OverviewResponse; shows: (tile: HeadlineTile) => boolean; periodLabel: string }): ReactElement | null {
  const h = o.headline;
  if (!h) return null;
  const c = o.currency;
  const compact = (v: string | null | undefined) => (v === null || v === undefined ? "—" : formatMoneyCompact(v, c).replace(`${c} `, ""));
  const exact = (v: string | null | undefined) => (v === null || v === undefined ? undefined : formatMoney(v, c));
  const through = o.asOf.through;
  const tiles: ReactElement[] = [];
  if (shows("headline.budget"))
    tiles.push(
      <StatTile key="budget" label={t("overview.tile.budget", { period: periodLabel })} value={compact(h.budget)} exact={exact(h.budget)} unit={c} testId="tile-budget">
        {h.assignedPct !== null && h.assignedPct !== undefined ? <PaceBar size="sm" spent={num(h.assignedPct)} elapsed={null} band="low" label={t("overview.tile.assigned", { assigned: formatMoneyCompact(h.assigned ?? "0", c), unassigned: formatMoneyCompact(h.unassigned ?? "0", c) })} /> : null}
        <span className="text-xs text-muted-foreground" data-testid="tile-budget-assigned">
          {h.unassigned && Number(h.unassigned) > 0 ? t("overview.tile.assigned", { assigned: formatMoneyCompact(h.assigned ?? "0", c), unassigned: formatMoneyCompact(h.unassigned, c) }) : t("overview.tile.assignedAll")}
        </span>
        {o.compare ? (
          <span className="text-xs text-muted-foreground" data-testid="tile-since">
            {o.compare.changeAbs !== null && Number(o.compare.changeAbs) === 0 ? t("overview.tile.sinceNone", { name: o.compare.name }) : t("overview.tile.since", { change: o.compare.changeAbs ? formatChange(o.compare.changeAbs, c) : "—", pct: o.compare.changePct ? formatPctChange(o.compare.changePct) : "—", name: o.compare.name })} ·{" "}
            <Link to="/w/$ws/budgets" params={{ ws }} search={{ compareTo: o.compare.id } as never} className="font-medium text-primary hover:underline">
              {t("overview.tile.sinceOpen")}
            </Link>
          </span>
        ) : null}
        {o.compare && o.compare.counts.increased + o.compare.counts.decreased + o.compare.counts.new + o.compare.counts.ended > 0 ? (
          <span className="text-xs text-muted-foreground" data-testid="since-plan-counts">
            {t("overview.tile.sinceCounts", o.compare.counts)}
          </span>
        ) : null}
      </StatTile>,
    );
  if (shows("headline.spent"))
    tiles.push(
      <StatTile key="spent" label={t("overview.tile.spent")} value={`${compact(h.actual)} · ${pct(h.spentPct)}`} exact={exact(h.actual)} unit={c} hint={t("overview.tile.paceFormula")} testId="tile-spent">
        <PaceBar spent={num(h.spentPct)} elapsed={num(o.period.elapsed)} band={paceBand(h.paceIndex)} pace={num(h.paceIndex)} />
        <span className="text-xs text-muted-foreground">{t("overview.tile.spentHint", { elapsed: pct(o.period.elapsed), date: through ? day(through) : "—", pace: h.paceIndex === null ? "—" : Number(h.paceIndex).toFixed(2) })}</span>
      </StatTile>,
    );
  if (shows("headline.remaining"))
    tiles.push(
      <StatTile key="remaining" label={t("overview.tile.remaining")} value={compact(h.remaining)} exact={exact(h.remaining)} unit={c} testId="tile-remaining">
        <span className="text-xs text-muted-foreground">{h.runRateNeeded ? t("overview.tile.remainingHint", { days: o.period.daysLeft ?? 0, rate: formatMoneyCompact(h.runRateNeeded, c) }) : t("overview.tile.remainingDays", { days: o.period.daysLeft ?? 0 })}</span>
      </StatTile>,
    );
  // Projected close only when the warehouse loaded projections (they are read, never computed here).
  if (shows("headline.projected") && h.projected !== null && h.projected !== undefined)
    tiles.push(
      <StatTile key="projected" label={t("overview.tile.projected")} value={pct(h.projectedClosePct)} testId="tile-projected">
        <span className="text-xs text-muted-foreground">{t("overview.tile.projectedHint", { amount: formatMoney(h.projected, c), source: o.freshness.projections?.source ?? "—", date: o.freshness.projections ? new Date(o.freshness.projections.loadedAt).toLocaleDateString("en", { day: "numeric", month: "short" }) : "—" })}</span>
      </StatTile>,
    );
  if (tiles.length === 0) return null;
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[repeat(auto-fit,minmax(15rem,1fr))]" data-testid="overview-tiles" data-tour="overview-headline">
      {tiles}
    </div>
  );
}
