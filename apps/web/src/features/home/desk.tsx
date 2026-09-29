import { paceBand, type HomeResponse } from "@budget/domain";
import { formatMoney, formatMoneyCompact } from "@budget/grid";
import { HeadlineStrip, PaceBar, type PulseItem } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { meQuery } from "../../lib/queries.js";
import { YourBudgets } from "./budgets.js";
import { DecideSheet } from "./decide-sheet.js";
import { Recents, Sent } from "./recents.js";
import { Waiting } from "./waiting.js";

/**
 * Home as the desk (HO-006, docs/HOME_OVERVIEW_PLAN.md §3.1): the workspace's pulse in one line, then
 * what waits on this person, their budgets, where they left off and what they sent. Every number is
 * the server's; this only lays it out.
 */
const pct = (v: string | null | undefined) => (v === null || v === undefined ? "—" : `${Math.round(Number(v) * 100)}%`);
const num = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));

export function Desk({ ws, home }: { ws: string; home: HomeResponse }): ReactElement {
  const { data: me } = useQuery(meQuery);
  const perms = me?.workspaces.find((w) => w.workspaceId === ws)?.permissions ?? [];
  const canCreate = me?.isOrgAdmin === true || perms.includes("envelope.create");
  // HO-007 (decision G4): an approval is decided in a side sheet, without leaving Home.
  const [deciding, setDeciding] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-5" data-testid="home-desk">
      <Pulse ws={ws} home={home} />
      <Waiting ws={ws} home={home} onDecide={setDeciding} />
      <YourBudgets ws={ws} home={home} canCreate={canCreate} />
      <div className="grid gap-5 lg:grid-cols-2">
        <Recents ws={ws} home={home} />
        <Sent ws={ws} home={home} />
      </div>
      {deciding ? <DecideSheet ws={ws} id={deciding} onClose={() => setDeciding(null)} /> : null}
    </div>
  );
}

/** The workspace this year in one line (decision G1): the Overview headline's numbers, and a way there. */
function Pulse({ ws, home }: { ws: string; home: HomeResponse }): ReactElement | null {
  const totals = home.totals;
  if (!totals) return null;
  const currency = home.workspace?.currency ?? "USD";
  const elapsed = home.asOf?.elapsed ?? home.workspace?.period.elapsed ?? null;
  const items: PulseItem[] = [
    { key: "budget", value: totals.budget ? formatMoneyCompact(totals.budget, currency) : "—", exact: totals.budget ? formatMoney(totals.budget, currency) : undefined, label: t("home.pulse.budget"), testId: "home-pulse-budget" },
    {
      key: "spent",
      value: pct(totals.spentPct),
      exact: totals.actual ? formatMoney(totals.actual, currency) : undefined,
      label: t("home.pulse.spent", { elapsed: pct(elapsed) }),
      bar: <PaceBar size="sm" spent={num(totals.spentPct)} elapsed={num(elapsed)} band={paceBand(totals.paceIndex)} pace={num(totals.paceIndex ?? null)} />,
      testId: "home-pulse-spent",
    },
    { key: "alerts", value: String(totals.openAlerts), label: t("home.pulse.alerts"), testId: "home-pulse-alerts" },
    { key: "waiting", value: String(totals.waiting ?? 0), label: totals.overdue ? t("home.pulse.waitingOverdue", { overdue: totals.overdue }) : t("home.pulse.waiting"), testId: "home-pulse-waiting" },
  ];
  return (
    <div data-tour="home-pulse">
      <HeadlineStrip
        title={t("home.pulse.title", { workspace: home.workspace?.name ?? "" })}
        items={items}
        action={
          <Link to="/w/$ws" params={{ ws }} className="text-sm font-medium text-primary hover:underline" data-testid="home-pulse-open">
            {t("home.pulse.open")} →
          </Link>
        }
        testId="home-pulse"
      />
    </div>
  );
}
