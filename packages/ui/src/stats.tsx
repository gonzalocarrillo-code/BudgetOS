import { AlertTriangle, Database } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { cn } from "./cn.js";
import { t, type MessageKey } from "./i18n.js";
import { Chip } from "./status-chip.js";

/**
 * Numbers at a glance (HO-002, docs/HOME_OVERVIEW_PLAN.md §3.3): the pace bar, the pace legend, a
 * stat tile, Home's one-line pulse and the as-of chip. They draw what the server computed; nothing
 * here sums or compares amounts. The pace band comes from `paceBand()` in @budget/domain.
 */

/** A pace band, as `paceBand()` in @budget/domain returns it. */
export type PaceTone = "under" | "low" | "on" | "high" | "over";
export const PACE_TONES: readonly PaceTone[] = ["under", "low", "on", "high", "over"];

/** Tint and text of a band (heatmap cells, legend chips); the text colour is also the bar's fill. */
export const PACE_TINT: Record<PaceTone, string> = {
  under: "bg-pace-under text-pace-under-text",
  low: "bg-pace-low text-pace-low-text",
  on: "bg-pace-on text-pace-on-text",
  high: "bg-pace-high text-pace-high-text",
  over: "bg-pace-over text-pace-over-text",
};
const FILL: Record<PaceTone, string> = {
  under: "bg-pace-under-text",
  low: "bg-pace-low-text",
  on: "bg-pace-on-text",
  high: "bg-pace-high-text",
  over: "bg-pace-over-text",
};

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * Spend against time on one bar: the fill is the share of the budget spent, the tick is the share
 * of the period gone, the colour is the pace band. Past 100% the fill stops at the end and a notch
 * says the budget is overspent. Screen readers get the numbers.
 */
export function PaceBar({
  spent,
  elapsed,
  band,
  pace,
  size = "md",
  label,
  className,
  testId,
}: {
  spent: number | null;
  elapsed: number | null;
  band: PaceTone | null;
  pace?: number | null;
  size?: "sm" | "md";
  label?: string;
  className?: string;
  testId?: string;
}): ReactElement {
  const fill = spent === null ? 0 : clamp01(spent);
  const tick = elapsed === null ? null : clamp01(elapsed);
  const spoken = label ?? (pace === null || pace === undefined ? t("pace.bar.label", { spent: pct(spent), elapsed: pct(elapsed) }) : t("pace.bar.labelPace", { spent: pct(spent), elapsed: pct(elapsed), pace: pace.toFixed(2) }));
  return (
    <span role="img" aria-label={spoken} className={cn("relative block rounded-full bg-muted", size === "sm" ? "h-1.5" : "h-2.5", className)} data-testid={testId} data-band={band ?? "none"}>
      <span className={cn("absolute inset-y-0 left-0 rounded-full", band ? FILL[band] : "bg-subtle-foreground")} style={{ width: `${(fill * 100).toFixed(1)}%` }} data-part="fill" />
      {spent !== null && spent > 1 ? <span className="absolute -inset-y-0.5 right-0 w-1 rounded-full bg-danger-text" title={t("pace.bar.over")} data-part="over" /> : null}
      {tick !== null ? <span className="absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-foreground/70" style={{ left: `${(tick * 100).toFixed(1)}%` }} data-part="tick" /> : null}
    </span>
  );
}

/** The five bands as chips, in order, with the words each one means (plan §11.1 "every colour has a legend"). */
export function PaceLegend({ className, testId, title }: { className?: string; testId?: string; title?: string }): ReactElement {
  return (
    <ul className={cn("flex flex-wrap items-center gap-1.5 text-xs", className)} aria-label={title ?? t("pace.legend")} data-testid={testId}>
      {title !== undefined ? <li className="mr-1 font-medium text-muted-foreground">{title}</li> : null}
      {PACE_TONES.map((b) => (
        <li key={b} className={cn("rounded-full px-2 py-0.5 font-medium", PACE_TINT[b])} data-band={b}>
          {t(`pace.band.${b}` as MessageKey)}
        </li>
      ))}
    </ul>
  );
}

/**
 * One number with its label (the Overview headline): `value` is what fits (compact money), `exact`
 * the full amount for the tooltip and screen readers; `unit` is the currency code, drawn small.
 */
export function StatTile({
  label,
  value,
  exact,
  unit,
  hint,
  children,
  className,
  testId,
}: {
  label: ReactNode;
  value: string;
  exact?: string | undefined;
  unit?: string | undefined;
  hint?: ReactNode;
  children?: ReactNode;
  className?: string;
  testId?: string;
}): ReactElement {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5 rounded-xl border border-border bg-card px-4 py-3 shadow-xs", className)} data-testid={testId}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="tabular flex min-w-0 items-baseline gap-1 text-2xl font-semibold tracking-[-0.02em]" title={exact} data-testid="tile-value">
        {unit ? <span className="text-xs font-medium text-muted-foreground">{unit}</span> : null}
        <span className="min-w-0 truncate" aria-hidden={exact !== undefined ? true : undefined}>
          {value}
        </span>
        {exact !== undefined ? <span className="sr-only">{exact}</span> : null}
      </span>
      {children}
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

/** One item of Home's pulse: a bold value and the words after it, maybe a small bar. */
export interface PulseItem {
  key: string;
  value: string;
  label: string;
  exact?: string | undefined;
  bar?: ReactNode;
  testId?: string;
}

/**
 * Home's pulse (HO-006, decision G1): the workspace in one line, the same numbers as the Overview
 * headline, and a way there. Wraps on narrow screens.
 */
export function HeadlineStrip({ title, items, action, className, testId }: { title: ReactNode; items: PulseItem[]; action?: ReactNode; className?: string; testId?: string }): ReactElement {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-card px-4 py-2.5 text-sm shadow-xs", className)} data-testid={testId}>
      <span className="font-semibold">{title}</span>
      {items.map((i) => (
        <span key={i.key} className="tabular flex items-center gap-1.5 whitespace-nowrap" data-testid={i.testId}>
          <span className="text-muted-foreground/50" aria-hidden>
            •
          </span>
          <span className="font-semibold" title={i.exact}>
            {i.value}
          </span>
          {i.bar ? <span className="w-20">{i.bar}</span> : null}
          <span className="text-muted-foreground">{i.label}</span>
        </span>
      ))}
      {action ? <span className="ml-auto">{action}</span> : null}
    </div>
  );
}

const shortDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/**
 * How current the actuals are (HO-003): the last day they cover, and how old that is once they are
 * stale. The same words on Home and the Overview; the tooltip says what "through" means for the grain.
 */
export function AsOfChip({ through, stale, staleDays, grain, className, testId }: { through: string | null; stale: boolean; staleDays: number | null; grain?: "day" | "month" | null; className?: string; testId?: string }): ReactElement {
  const text = through === null ? t("asof.none") : t("asof.through", { date: shortDate(through) });
  const old = stale && staleDays !== null ? ` · ${t("asof.old", { days: staleDays })}` : "";
  const tip = [grain === "month" ? t("asof.monthly") : grain === "day" ? t("asof.daily") : null, t("asof.hint")].filter(Boolean).join(" ");
  return (
    <Chip tone={stale ? "warning" : "neutral"} icon={stale ? AlertTriangle : Database} className={className} title={tip} data-testid={testId} data-stale={stale}>
      {text}
      {old}
    </Chip>
  );
}
