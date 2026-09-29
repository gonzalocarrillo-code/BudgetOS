import { LIVE_LEAVES, type OverviewAttention, type OverviewAttentionItem } from "@budget/domain";
import { formatMoney } from "@budget/grid";
import { Popover, PopoverContent, PopoverTrigger, cn } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { Link } from "@tanstack/react-router";
import { ArrowDownRight, ArrowUpRight, Bell, CircleDashed, Flag, Target } from "lucide-react";
import { useState, type ReactElement } from "react";
import { Card } from "../../components/page.js";
import { SeverityChip } from "../../routes/w.$ws.alerts.js";

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
  // One short line in the text colour, the detail under it; only the icon carries the tone.
  const [line, detail] =
    i.category === "over"
      ? [t("overview.attention.ahead", { amount: money }), null]
      : i.category === "under"
        ? [t("overview.attention.behind", { amount: money }), null]
        : i.category === "no_spend"
          ? [t("overview.attention.noSpend"), t("overview.attention.planned", { amount: money })]
          : [t("overview.attention.kpiLine", { actual: i.kpi?.actual ? Number(i.kpi.actual).toFixed(2) : "—", target: i.kpi?.target ? Number(i.kpi.target).toFixed(2) : "—" }), t("overview.attention.kpiCost", { amount: money })];
  const Icon = i.category === "over" ? ArrowUpRight : i.category === "under" ? ArrowDownRight : i.category === "no_spend" ? CircleDashed : Target;
  const tone = i.category === "under" ? "text-pace-under-text" : i.category === "no_spend" ? "text-muted-foreground" : "text-warning-text";
  return (
    <li className="grid items-center gap-x-4 gap-y-1 py-2.5 text-sm md:grid-cols-[1.25rem_minmax(0,1fr)_14rem_9rem_5.5rem]" data-testid="attention-row" data-category={i.category}>
      <Icon className={cn("size-4", tone)} aria-hidden />
      <Link to="/w/$ws/budgets" params={{ ws }} search={{ select: i.envelopeId } as never} className="min-w-0 hover:text-primary">
        <span className="block truncate font-medium">{i.name}</span>
        <span className="block truncate text-xs text-muted-foreground">{i.path.slice(0, -1).join(" › ")}</span>
      </Link>
      <span className="min-w-0">
        <span className="tabular block truncate font-medium text-foreground" title={detail ? `${line} · ${detail}` : line}>
          {line}
        </span>
        {detail ? <span className="tabular block truncate text-xs text-muted-foreground">{detail}</span> : null}
      </span>
      <span className="tabular truncate text-xs text-muted-foreground">
        {t("overview.attention.spent", { pct: pct(i.spend_to_date_pct) })} · {t("overview.attention.pace", { pace: i.pace_index === null || i.pace_index === undefined ? "—" : Number(i.pace_index).toFixed(2) })}
      </span>
      <span className="flex items-center justify-end gap-1.5">
        {i.pending ? (
          <span className="grid size-7 place-items-center rounded-md text-info-text" title={t("overview.attention.waiting")} aria-label={t("overview.attention.waiting")} data-testid="attention-pending">
            <Flag className="size-3.5" aria-hidden />
          </span>
        ) : null}
        {i.alerts > 0 ? <AlertBell ws={ws} i={i} /> : null}
      </span>
    </li>
  );
}

/** The budget's open alerts: a bell; hovering (or focusing) it lists them, a click opens them in Alerts. */
function AlertBell({ ws, i }: { ws: string; i: OverviewAttentionItem }): ReactElement {
  const [open, setOpen] = useState(false);
  const label = t("overview.attention.alerts", { count: i.alerts });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Link
          to="/w/$ws/alerts"
          params={{ ws }}
          search={{ status: "OPEN", under: i.envelopeId } as never}
          className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          aria-label={label}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          data-testid="attention-alerts"
        >
          <Bell className="size-4" aria-hidden />
        </Link>
      </PopoverTrigger>
      <PopoverContent className="w-80" onOpenAutoFocus={(e) => e.preventDefault()} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} data-testid="attention-alerts-card">
        <p className="mb-2 text-xs font-medium text-muted-foreground">{label}</p>
        <ul className="flex flex-col gap-1.5 text-sm">
          {i.alertList.map((a) => (
            <li key={a.id} className="flex items-center gap-2">
              <SeverityChip severity={a.severity} />
              <span className="min-w-0 flex-1 truncate">{a.rule ?? "—"}</span>
              <span className="tabular shrink-0 text-xs text-muted-foreground">{new Date(a.openedAt).toLocaleDateString("en", { day: "numeric", month: "short" })}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">{t("overview.attention.alertsOpen")}</p>
      </PopoverContent>
    </Popover>
  );
}
