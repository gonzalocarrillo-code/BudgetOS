import { LIVE_LEAVES, type OverviewAttention, type OverviewAttentionItem } from "@budget/domain";
import { formatMoney } from "@budget/grid";
import { Chip, cn } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { Link } from "@tanstack/react-router";
import { ArrowDownRight, ArrowUpRight, Bell, CircleDashed, Flag, Target } from "lucide-react";
import { useState, type ReactElement } from "react";
import { Card } from "../../components/page.js";

/**
 * Needs attention (HO-014, ADR-064): the live budgets furthest from plan in money, in four kinds.
 * The server ranks and counts; the chips only choose which of its lists to show.
 */
type Kind = "all" | "over" | "under" | "no_spend" | "kpi";
const KINDS: Kind[] = ["all", "over", "under", "no_spend", "kpi"];
const listOf = (a: OverviewAttention, k: Kind) => (k === "all" ? a.all : k === "over" ? a.over : k === "under" ? a.under : k === "no_spend" ? a.noSpend : a.kpi);
const countOf = (a: OverviewAttention, k: Kind) => (k === "all" ? null : k === "over" ? a.counts.over : k === "under" ? a.counts.under : k === "no_spend" ? a.counts.noSpend : a.counts.kpi);
const pct = (v: string | null | undefined) => (v === null || v === undefined ? "—" : `${Math.round(Number(v) * 100)}%`);
const measure = (key: string, op: string, value: number) => ({ field: { kind: "measure", key }, op, value });

/** The same budgets in Budgets, as a filter the Explorer reads (sorting there is the grid's own). */
function filterFor(k: Kind) {
  const children: unknown[] = [...LIVE_LEAVES];
  if (k === "over") children.push(measure("pace_index", "gte", 1.05), measure("ahead_of_plan_abs", "gt", 0));
  if (k === "under") children.push(measure("actual", "gt", 0), measure("pace_index", "lt", 0.95));
  if (k === "no_spend") children.push(measure("actual", "lte", 0), measure("ahead_of_plan_abs", "lt", 0));
  if (k === "kpi") children.push({ field: { kind: "target", metric: "cpa", field: "vs_target_pct" }, op: "gt", value: 1.1 });
  return { logic: "and", children };
}

export function Attention({ ws, a, currency, period }: { ws: string; a: OverviewAttention; currency: string; period: Record<string, unknown> }): ReactElement {
  const [kind, setKind] = useState<Kind>("all");
  const items = listOf(a, kind);
  // No grand total: a budget can be in two lists (under pace and off its KPI target); each chip counts its own.
  return (
    <Card
      title={t("overview.attention.title")}
      tour="overview-attention"
      testId="overview-attention"
      actions={
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("overview.section.attention")}>
          {KINDS.map((k) => {
            const n = countOf(a, k);
            return (
              <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)} className={cn("h-7 rounded-full border px-2.5 text-xs font-medium", kind === k ? "border-foreground bg-foreground text-card" : "border-border bg-card text-foreground hover:bg-accent")} data-testid={`attention-${k}`}>
                {t(`overview.attention.${k}` as MessageKey)}
                {n === null ? "" : ` ${n}`}
              </button>
            );
          })}
        </div>
      }
    >
      {items.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground" data-testid="attention-empty">
          {t("overview.attention.empty")}
        </p>
      ) : (
        <ol className="-my-1 flex flex-col divide-y divide-border" data-testid="attention-list">
          {items.map((i) => (
            <Row key={`${i.category}-${i.envelopeId}`} ws={ws} i={i} currency={currency} />
          ))}
        </ol>
      )}
      {kind !== "all" ? (
        <div className="mt-2">
          <Link to="/w/$ws/budgets" params={{ ws }} search={{ filter: filterFor(kind), period } as never} className="text-sm font-medium text-primary hover:underline" data-testid="attention-see-all">
            {t("overview.attention.seeAll")} →
          </Link>
        </div>
      ) : null}
    </Card>
  );
}

function Row({ ws, i, currency }: { ws: string; i: OverviewAttentionItem; currency: string }): ReactElement {
  const money = formatMoney(i.money.replace(/^-/, ""), currency);
  const line =
    i.category === "over"
      ? t("overview.attention.ahead", { amount: `+${money}` })
      : i.category === "under"
        ? t("overview.attention.behind", { amount: `−${money}` })
        : i.category === "no_spend"
          ? t("overview.attention.noSpend", { amount: money })
          : t("overview.attention.kpiLine", { actual: i.kpi?.actual ? Number(i.kpi.actual).toFixed(2) : "—", target: i.kpi?.target ? Number(i.kpi.target).toFixed(2) : "—", amount: money });
  const Icon = i.category === "over" ? ArrowUpRight : i.category === "under" ? ArrowDownRight : i.category === "no_spend" ? CircleDashed : Target;
  const tone = i.category === "over" || i.category === "kpi" ? "text-danger-text" : i.category === "under" ? "text-pace-under-text" : "text-muted-foreground";
  return (
    <li className="grid items-center gap-x-4 gap-y-1 py-2.5 text-sm md:grid-cols-[1.25rem_minmax(0,1fr)_16rem_10rem_auto]" data-testid="attention-row" data-category={i.category}>
      <Icon className={cn("size-4", tone)} aria-hidden />
      <Link to="/w/$ws/budgets" params={{ ws }} search={{ select: i.envelopeId } as never} className="min-w-0 hover:text-primary">
        <span className="block truncate font-medium">{i.name}</span>
        <span className="block truncate text-xs text-muted-foreground">{i.path.slice(0, -1).join(" › ")}</span>
      </Link>
      <span className={cn("tabular font-semibold", tone)}>{line}</span>
      <span className="tabular text-xs text-muted-foreground">
        {t("overview.attention.spent", { pct: pct(i.spend_to_date_pct) })} · {t("overview.attention.pace", { pace: i.pace_index === null || i.pace_index === undefined ? "—" : Number(i.pace_index).toFixed(2) })}
      </span>
      <span className="flex gap-1.5">
        {i.alerts > 0 ? (
          <Chip tone="danger" icon={Bell}>
            {i.alerts}
          </Chip>
        ) : null}
        {i.pending ? (
          <Chip tone="info" icon={Flag} title={t("overview.attention.waiting")}>
            {t("status.word.PENDING")}
          </Chip>
        ) : null}
      </span>
    </li>
  );
}
