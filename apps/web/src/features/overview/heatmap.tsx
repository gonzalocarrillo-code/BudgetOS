import { HEATMAP_SORTS, paceBand, type OverviewHeatmap, type OverviewHeatmapCell, type OverviewMargin } from "@budget/domain";
import { formatMoney, formatMoneyCompact } from "@budget/grid";
import { Button, cn, PACE_TINT, PaceBar, PaceLegend, Popover, PopoverContent, PopoverTrigger, Select, moneyOrDash } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { Link } from "@tanstack/react-router";
import { useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { Card } from "../../components/page.js";
import { cellFilter, type CellRef } from "./cell-editor.js";

/**
 * The heatmap (HO-013, docs/HOME_OVERVIEW_PLAN.md §3.2): any two granularities, with row and column
 * totals from the planner. A cell's number is the share of its budget spent; its colour is its pace
 * band (as of the data, ADR-062); a dot counts its open alerts. Enter or a click opens a popover with
 * the numbers and two actions, Open in Budgets and Edit these budgets; arrow keys move between cells.
 * On a phone the grid becomes a list of rows for one column at a time.
 */
const COLS_SHOWN = 8;
const ROWS_SHOWN = 12;
const pct = (v: string | null | undefined) => (v === null || v === undefined ? "—" : `${Math.round(Number(v) * 100)}%`);
const pace = (v: string | null | undefined) => (v === null || v === undefined ? "—" : Number(v).toFixed(2));
const num = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));
const tint = (p: string | null | undefined) => {
  const b = paceBand(p);
  return b ? PACE_TINT[b] : "bg-surface text-foreground";
};

export interface HeatmapProps {
  ws: string;
  h: OverviewHeatmap;
  currency: string;
  through: string | null;
  period: Record<string, unknown>;
  compareName: string | null;
  /** The share of the period gone by the data's last day: the phone list's time tick. */
  elapsed: number | null;
  onAxes: (axes: { rows?: string; cols?: string }) => void;
  onSort: (sort: (typeof HEATMAP_SORTS)[number]) => void;
  onEdit: (cell: CellRef) => void;
}

export function Heatmap(p: HeatmapProps): ReactElement {
  const { h } = p;
  const [allCols, setAllCols] = useState(false);
  const [allRows, setAllRows] = useState(false);
  const cols = allCols ? h.cols : h.cols.slice(0, COLS_SHOWN);
  const rows = allRows ? h.rows : h.rows.slice(0, ROWS_SHOWN);
  const label = (kind: "rows" | "cols", code: string) => h.labels[kind][code] ?? code;
  const through = p.through ? new Date(`${p.through}T00:00:00Z`).toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" }) : "—";
  const axis = (which: "rows" | "cols", value: string, other: string) => (
    <label className="flex items-center gap-1.5 text-sm font-normal text-muted-foreground">
      <span className="sr-only">{t(which === "rows" ? "overview.axis.rows" : "overview.axis.cols")}</span>
      <Select className="text-foreground" size="sm" value={value} onChange={(e) => p.onAxes({ [which]: e.target.value })} data-testid={`heatmap-${which}`}>
        {h.dimensions.filter((d) => d.key !== other).map((d) => (
          <option key={d.key} value={d.key}>
            {d.label}
          </option>
        ))}
      </Select>
    </label>
  );
  const title = (
    <span className="flex flex-wrap items-center gap-2">
      {t("overview.heatmap.by")}
      {axis("rows", h.rowDimension.key, h.colDimension.key)}
      <span className="text-muted-foreground" aria-hidden>
        ×
      </span>
      {axis("cols", h.colDimension.key, h.rowDimension.key)}
    </span>
  );
  const empty = h.rows.length === 0 || h.cols.length === 0;
  return (
    <Card
      title={title}
      tour="overview-heatmap"
      testId="heatmap-card"
      actions={
        <>
          <PaceLegend testId="heatmap-legend" />
          <label className="flex items-center gap-1.5">
            {t("overview.heatmap.sort")}
            <Select size="sm" className="text-foreground" value={h.sort} onChange={(e) => p.onSort(e.target.value as (typeof HEATMAP_SORTS)[number])} data-testid="heatmap-sort">
              {HEATMAP_SORTS.map((s) => (
                <option key={s} value={s}>
                  {t(`overview.heatmap.sort.${s}` as MessageKey)}
                </option>
              ))}
            </Select>
          </label>
        </>
      }
    >
      {empty ? (
        <p className="text-sm text-muted-foreground" data-testid="heatmap-empty">
          {t("overview.heatmapEmpty", { rows: h.rowDimension.label, cols: h.colDimension.label })}
        </p>
      ) : (
        <>
          <Grid {...p} rows={rows} cols={cols} label={label} />
          <PhoneList {...p} rows={rows} label={label} />
          <div className="mt-2 flex flex-wrap items-center gap-3">
            {h.cols.length > COLS_SHOWN ? (
              <Button size="sm" variant="ghost" className="hidden md:inline-flex" onClick={() => setAllCols((v) => !v)} data-testid="heatmap-all-cols">
                {allCols ? t("overview.fewerCols") : t("overview.allCols", { count: h.cols.length, dimension: h.colDimension.label })}
              </Button>
            ) : null}
            {h.rows.length > ROWS_SHOWN ? (
              <Button size="sm" variant="ghost" onClick={() => setAllRows((v) => !v)} data-testid="heatmap-all-rows">
                {allRows ? t("overview.fewerRows") : t("overview.allRows", { count: h.rows.length, dimension: h.rowDimension.label })}
              </Button>
            ) : null}
            <span className="hidden text-xs text-muted-foreground md:inline">{t("overview.heatmap.hint", { date: through })}</span>
          </div>
        </>
      )}
    </Card>
  );
}

function Grid({ ws, h, currency, period, compareName, onEdit, rows, cols, label }: HeatmapProps & { rows: string[]; cols: string[]; label: (kind: "rows" | "cols", code: string) => string }): ReactElement {
  const byCell = new Map(h.cells.map((c) => [`${c.row}\u0000${c.col}`, c]));
  const rowTotal = new Map(h.rowTotals.map((m) => [m.code, m]));
  const colTotal = new Map(h.colTotals.map((m) => [m.code, m]));
  // Roving focus: one cell takes Tab; arrow keys move to the next cell that has budgets.
  const [focus, setFocus] = useState<[number, number]>([0, 0]);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const move = (e: KeyboardEvent, r: number, c: number) => {
    const d = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key] as [number, number] | undefined;
    if (!d) return;
    e.preventDefault();
    for (let nr = r + d[0], nc = c + d[1]; nr >= 0 && nr < rows.length && nc >= 0 && nc < cols.length; nr += d[0], nc += d[1]) {
      const el = refs.current.get(`${nr}:${nc}`);
      if (el) {
        setFocus([nr, nc]);
        el.focus();
        return;
      }
    }
  };
  const compact = (v: string | null | undefined) => (v === null || v === undefined ? "—" : formatMoneyCompact(v, currency));
  return (
    <div className="hidden overflow-x-auto md:block">
      <table className="tabular w-full border-separate border-spacing-1 text-sm" data-testid="heatmap">
        <caption className="sr-only">{t("overview.heatmapCaption")}</caption>
        <thead>
          <tr>
            <th scope="col" className="px-2 text-left text-xs font-medium text-muted-foreground">
              {h.rowDimension.label}
            </th>
            {cols.map((c) => (
              <th key={c} scope="col" className="px-2 text-left text-xs font-medium text-muted-foreground" data-testid="heatmap-col" data-code={c}>
                {label("cols", c)}
              </th>
            ))}
            <th scope="col" className="border-l-2 border-border px-2 text-right text-xs font-medium text-muted-foreground">
              {t("overview.heatmap.total", { dimension: h.rowDimension.label })}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={r} data-testid="heatmap-row" data-code={r}>
              <th scope="row" className="max-w-48 px-2 text-left font-medium" title={label("rows", r)}>
                <span className="block truncate">{label("rows", r)}</span>
                {rowTotal.get(r)?.alerts ? <span className="block text-xs font-normal text-muted-foreground">{t("overview.heatmap.alerts", { count: rowTotal.get(r)?.alerts ?? 0 })}</span> : null}
              </th>
              {cols.map((c, ci) => {
                const x = byCell.get(`${r}\u0000${c}`);
                if (!x) {
                  return (
                    <td key={c} className="p-0">
                      <span className="block min-w-24 rounded-md bg-surface/60 px-2 py-1.5 text-xs text-muted-foreground">—</span>
                    </td>
                  );
                }
                const ref: CellRef = { row: { key: h.rowDimension.key, code: r, label: label("rows", r) }, col: { key: h.colDimension.key, code: c, label: label("cols", c) } };
                const first = focus[0] === ri && focus[1] === ci;
                return (
                  <td key={c} className="p-0">
                    <CellPopover ws={ws} cell={x} cellRef={ref} currency={currency} period={period} compareName={compareName} onEdit={onEdit}>
                      <button
                        type="button"
                        ref={(el) => {
                          if (el) refs.current.set(`${ri}:${ci}`, el);
                          else refs.current.delete(`${ri}:${ci}`);
                        }}
                        tabIndex={first ? 0 : -1}
                        onFocus={() => setFocus([ri, ci])}
                        onKeyDown={(e) => move(e, ri, ci)}
                        className={cn("relative flex w-full min-w-24 flex-col rounded-md px-2 py-1.5 text-left outline-none ring-offset-1 hover:ring-2 hover:ring-primary focus-visible:ring-2 focus-visible:ring-ring", tint(x.pace_index))}
                        aria-label={t("overview.cellLabel", { row: label("rows", r), col: label("cols", c), spent: pct(x.spend_to_date_pct), budget: moneyOrDash(x.budget, currency), actual: moneyOrDash(x.actual, currency) })}
                        data-testid="heatmap-cell"
                        data-band={paceBand(x.pace_index) ?? "none"}
                      >
                        <span className="font-semibold" data-testid="heatmap-spent">
                          {pct(x.spend_to_date_pct)}
                        </span>
                        <span className="text-xs opacity-80">{compact(x.budget)}</span>
                        {x.alerts > 0 ? (
                          <span className="absolute right-1.5 top-1.5 inline-flex items-center gap-0.5 text-xs font-semibold text-danger-text" data-testid="heatmap-cell-alerts">
                            <span className="inline-block size-1.5 rounded-full bg-destructive" aria-hidden />
                            {x.alerts}
                          </span>
                        ) : null}
                      </button>
                    </CellPopover>
                  </td>
                );
              })}
              <td className="border-l-2 border-border px-2 text-right" data-testid="heatmap-row-total">
                <Margin m={rowTotal.get(r)} currency={currency} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-border">
            <th scope="row" className="px-2 pt-2 text-left font-medium">
              {t("overview.heatmap.total", { dimension: h.colDimension.label })}
            </th>
            {cols.map((c) => (
              <td key={c} className="px-2 pt-2 text-right" data-testid="heatmap-col-total">
                <Margin m={colTotal.get(c)} currency={currency} />
              </td>
            ))}
            <td className="border-l-2 border-border px-2 pt-2 text-right" data-testid="heatmap-total">
              <Margin m={h.total ? { code: null, ...h.total, alerts: 0 } : undefined} currency={currency} strong />
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function Margin({ m, currency, strong = false }: { m: OverviewMargin | undefined; currency: string; strong?: boolean }): ReactElement {
  if (!m) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <span className="inline-flex flex-col items-end whitespace-nowrap text-xs text-muted-foreground">
      <span className={cn("text-sm text-foreground", strong ? "font-bold" : "font-semibold")}>
        {pct(m.spend_to_date_pct)} · {moneyOrDash(m.budget, currency, true)}
      </span>
      <span>{t("overview.paceTitle", { pace: pace(m.pace_index) })}</span>
    </span>
  );
}

/** Money ahead of plan (over pace) or behind it, without a sign to decode. */
const aheadLine = (v: string | null | undefined, currency: string) => {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  const amount = formatMoney(v.replace(/^-/, ""), currency);
  return n > 0 ? t("overview.cell.aheadBy", { amount }) : n < 0 ? t("overview.cell.behindBy", { amount }) : t("overview.cell.onPlan");
};

/** A cell's popover: what it holds, and the two things to do with it. */
function CellPopover({ ws, cell, cellRef, currency, period, compareName, onEdit, children }: { ws: string; cell: OverviewHeatmapCell; cellRef: CellRef; currency: string; period: Record<string, unknown>; compareName: string | null; onEdit: (cell: CellRef) => void; children: ReactElement }): ReactElement {
  const [open, setOpen] = useState(false);
  const band = paceBand(cell.pace_index);
  const rows: Array<[string, string]> = [
    [t("overview.cell.budgets"), moneyOrDash(cell.budget, currency)],
    [t("overview.cell.spent"), `${moneyOrDash(cell.actual, currency)} · ${pct(cell.spend_to_date_pct)}`],
    [t("overview.cell.pace"), `${pace(cell.pace_index)}${band ? ` · ${t(`home.band.${band}` as MessageKey)}` : ""}`],
    [t("overview.cell.ahead"), aheadLine(cell.ahead_of_plan_abs, currency)],
    [t("overview.cell.alerts"), String(cell.alerts)],
    [t("overview.cell.waiting"), String(cell.pending)],
    ...(cell.budget_baseline !== undefined && compareName ? ([[t("overview.cell.baseline", { name: compareName }), cell.budget_baseline === null ? "—" : formatMoney(cell.budget_baseline, currency)]] as Array<[string, string]>) : []),
  ];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-80" data-testid="cell-popover">
        <p className="mb-2 text-sm font-semibold">{t("overview.cell.title", { row: cellRef.row.label, col: cellRef.col.label })}</p>
        <dl className="tabular grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="text-right font-medium">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link to="/w/$ws/budgets" params={{ ws }} search={{ filter: cellFilter(cellRef), period } as never} className="inline-flex h-8 items-center rounded-lg border border-border px-3 text-sm font-medium hover:bg-accent" data-testid="cell-open-budgets">
            {t("overview.cell.open")}
          </Link>
          <Button
            size="sm"
            onClick={() => {
              setOpen(false);
              onEdit(cellRef);
            }}
            data-testid="cell-edit"
          >
            {t("overview.cell.edit")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Below 768 px: one column at a time (or the row totals), as a ranked list of rows with pace bars. */
function PhoneList({ h, currency, elapsed, rows, label }: HeatmapProps & { rows: string[]; label: (kind: "rows" | "cols", code: string) => string }): ReactElement {
  const [col, setCol] = useState<string>("");
  const rowTotal = new Map(h.rowTotals.map((m) => [m.code, m]));
  const byCell = new Map(h.cells.map((c) => [`${c.row}\u0000${c.col}`, c]));
  return (
    <div className="flex flex-col gap-3 md:hidden" data-testid="heatmap-phone">
      <p className="text-xs text-muted-foreground">{t("overview.heatmap.phone")}</p>
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        {t("overview.heatmap.column")}
        <Select size="sm" className="text-foreground" value={col} onChange={(e) => setCol(e.target.value)} data-testid="heatmap-phone-col">
          <option value="">{t("overview.heatmap.total", { dimension: h.rowDimension.label })}</option>
          {h.cols.map((c) => (
            <option key={c} value={c}>
              {label("cols", c)}
            </option>
          ))}
        </Select>
      </label>
      <ul className="flex flex-col divide-y divide-border">
        {rows.map((r) => {
          const x = col === "" ? rowTotal.get(r) : byCell.get(`${r}\u0000${col}`);
          return (
            <li key={r} className="flex flex-col gap-1.5 py-2" data-testid="heatmap-phone-row">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="truncate font-medium">{label("rows", r)}</span>
                <span className="tabular font-semibold">{x ? pct(x.spend_to_date_pct) : "—"}</span>
              </div>
              <PaceBar size="sm" spent={num(x?.spend_to_date_pct)} elapsed={elapsed} band={paceBand(x?.pace_index)} pace={num(x?.pace_index)} />
              <span className="tabular text-xs text-muted-foreground">
                {x ? `${moneyOrDash(x.budget, currency, true)} · ${t("overview.paceTitle", { pace: pace(x.pace_index) })}` : "—"}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
