import { paceBand, type HomeResponse } from "@budget/domain";
import { formatMoney } from "@budget/grid";
import { Chip, PaceBar, PaceLegend } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { Link } from "@tanstack/react-router";
import { Bell, Flag, Plus } from "lucide-react";
import type { ReactElement } from "react";
import { Card } from "../../components/page.js";
import { dayMonth } from "./time.js";

/**
 * Your budgets (HO-006): one row per top-level budget the person owns or reads, owned first. The bar
 * is the share spent, the tick the year gone by the day the actuals cover, the colour the pace band;
 * chips say what waits under it. A row opens that budget in Budgets.
 */
const pct = (v: string | null | undefined) => (v === null || v === undefined ? "—" : `${Math.round(Number(v) * 100)}%`);
const num = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));

export function YourBudgets({ ws, home, canCreate }: { ws: string; home: HomeResponse; canCreate: boolean }): ReactElement {
  const currency = home.workspace?.currency ?? "USD";
  const elapsed = num(home.asOf?.elapsed ?? home.workspace?.period.elapsed);
  const through = home.asOf?.through ?? null;
  const fy = home.workspace ? `FY${home.workspace.period.start.slice(0, 4)}` : "";
  return (
    <Card title={t("home.budgets.title", { period: fy })} tour="home-pacing" actions={through ? <span>{t("pace.legend")}</span> : null}>
      {home.scopes.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">{t("home.pacingEmpty")}</p>
      ) : (
        <ul className="-my-1 flex flex-col divide-y divide-border" data-testid="home-scopes">
          {home.scopes.map((s) => {
            const band = paceBand(s.paceIndex);
            return (
              <li key={s.envelopeId ?? s.label}>
                <Link to="/w/$ws/budgets" params={{ ws }} search={{ select: s.envelopeId } as never} className="grid gap-x-6 gap-y-2 rounded-lg py-3 hover:bg-accent/40 md:grid-cols-[14rem_1fr_13rem] md:items-center" data-testid="home-scope">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 font-semibold">
                      <span className="truncate">{s.label}</span>
                      {s.owner ? <Chip tone="info">{t("home.budgets.owner")}</Chip> : null}
                    </p>
                    <p className="tabular text-xs text-muted-foreground">{t("home.spentOf", { actual: s.actual ? formatMoney(s.actual, currency) : "—", budget: s.budget ? formatMoney(s.budget, currency) : "—" })}</p>
                  </div>
                  <div className="flex min-w-0 flex-col gap-2">
                    <PaceBar spent={num(s.spentPct)} elapsed={elapsed} band={band} pace={num(s.paceIndex)} testId="home-scope-bar" />
                    <div className="flex flex-wrap gap-1.5">
                      <Chip tone={(s.pending ?? 0) > 0 ? "info" : "neutral"} icon={Flag}>
                        {t("home.budgets.waiting", { count: s.pending ?? 0 })}
                      </Chip>
                      <Chip tone={(s.alerts ?? 0) > 0 ? "danger" : "neutral"} icon={Bell}>
                        {t("home.budgets.alerts", { count: s.alerts ?? 0 })}
                      </Chip>
                      <Chip tone="neutral">{s.projected && Number(s.projected) > 0 ? t("home.budgets.projected", { amount: formatMoney(s.projected, currency) }) : t("home.budgets.noProjections")}</Chip>
                    </div>
                  </div>
                  <div className="tabular flex flex-col gap-0.5 text-sm md:items-end">
                    <span className="font-semibold" data-testid="home-scope-spent">
                      {pct(s.spentPct)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t("home.budgets.pace", { pace: s.paceIndex === null ? "—" : Number(s.paceIndex).toFixed(2) })}
                      {band ? ` · ${t(`home.band.${band}` as MessageKey)}` : ""}
                    </span>
                    <span className="text-xs text-muted-foreground">{s.remaining ? t("home.budgets.remaining", { amount: formatMoney(s.remaining, currency) }) : ""}</span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-border pt-3 text-xs text-muted-foreground">
        {through ? <span>{t("home.budgets.legend", { date: dayMonth(through) })}</span> : null}
        <PaceLegend />
        {canCreate ? (
          <Link to="/w/$ws/budgets" params={{ ws }} search={{ new: true } as never} className="ml-auto inline-flex h-7 items-center gap-1 rounded-lg border border-border px-2.5 font-medium text-foreground hover:bg-accent" data-testid="home-new-budget-small">
            <Plus className="size-3.5" aria-hidden />
            {t("home.budgets.new")}
          </Link>
        ) : null}
      </div>
    </Card>
  );
}
