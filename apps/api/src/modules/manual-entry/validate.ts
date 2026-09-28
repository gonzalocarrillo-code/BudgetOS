import { DomainError, type ManualEntryIssue, type ManualEntryRowInput, type ManualEntryTotals } from "@budget/domain";
import { closedPeriods, tuplesWithEnvelope, type Tx } from "@budget/db";
import { FxCache, loadRegistry, parseDate } from "@budget/workers";
import { Decimal } from "decimal.js";

/**
 * Validation of a manual entry batch (spec §26.2), the way ingestion validates a row (spec §14):
 * dimension values resolve against the registry (code, alias, external id; merged values follow
 * the merge), the date is a day inside the batch's period and not in a closed period, the amount is
 * money, the currency has an FX rate into the reporting currency, KPI values are numbers. Blank
 * rows are dropped. Rows no live budget would take are warned about (they would be unmatched).
 */

export interface NormalizedRow {
  rowNo: number;
  dimensionValues: Record<string, string>;
  periodDate: string;
  currency: string;
  amount: string;
  kpis: Record<string, string>;
  note?: string | undefined;
}

export interface ValidatedBatch {
  rows: NormalizedRow[];
  issues: ManualEntryIssue[];
  warnings: ManualEntryIssue[];
  totals: ManualEntryTotals;
  /** Reporting-currency amount per row (null without an FX rate), for loading the facts. */
  reporting: Map<number, { amount: string; fxRateId: string | null }>;
}

const MONEY = /^\d{1,16}(\.\d{1,2})?$/;
const KPI = /^\d{1,14}(\.\d{1,4})?$/;
const METRIC = /^[a-z][a-z0-9_]{0,62}$/;
const blank = (r: ManualEntryRowInput) => !r.amount.trim() && !r.periodDate.trim() && Object.values(r.dimensionValues).every((v) => !v.trim()) && Object.values(r.kpis).every((v) => !v.trim());

/** The batch's channel as a registry code; a batch-level error, not a row issue. */
export async function resolveChannel(tx: Tx, orgId: string, workspaceId: string, channel: string): Promise<string> {
  const registry = await loadRegistry(tx, orgId, workspaceId);
  if (!registry.has("channel")) throw new DomainError("VALIDATION", "This workspace has no `channel` granularity in its registry");
  const hit = registry.resolve("channel", channel);
  if ("error" in hit) throw new DomainError("VALIDATION", `Unknown channel: ${hit.error}`, { channel });
  return hit.code;
}

export async function validateBatch(tx: Tx, ctx: { orgId: string; workspaceId: string }, batch: { channel: string; periodStart: string; periodEnd: string }, input: ManualEntryRowInput[]): Promise<ValidatedBatch> {
  const registry = await loadRegistry(tx, ctx.orgId, ctx.workspaceId);
  const ws = await tx.workspace.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { reportingCurrency: true } });
  const fx = new FxCache(ws.reportingCurrency);
  const closed = await closedPeriods(tx, ctx.workspaceId);
  const issues: ManualEntryIssue[] = [];
  const rows: NormalizedRow[] = [];
  const reporting = new Map<number, { amount: string; fxRateId: string | null }>();
  const byCurrency = new Map<string, Decimal>();
  let total: Decimal | null = new Decimal(0);

  for (const raw of input.filter((r) => !blank(r))) {
    const rowNo = rows.length + 1;
    const issue = (field: string, message: string) => issues.push({ rowNo, field, message });
    const dims: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.dimensionValues)) {
      const v = value.trim();
      if (!v) continue;
      if (key === "channel") {
        if (v !== batch.channel) issue("dimension:channel", `channel is the batch's (${batch.channel}); use another batch for "${v}"`);
        continue;
      }
      if (!registry.has(key)) {
        issue(`dimension:${key}`, `unknown granularity "${key}"`);
        dims[key] = v;
        continue;
      }
      const hit = registry.resolve(key, v);
      if ("error" in hit) issue(`dimension:${key}`, hit.error);
      dims[key] = "error" in hit ? v : hit.code;
    }
    if (Object.keys(dims).length === 0) issue("dimensions", "needs at least one granularity (e.g. country) to find its budget");

    const periodDate = parseDate(raw.periodDate.trim(), "yyyy-MM-dd") ?? parseDate(raw.periodDate.trim(), "yyyy-MM");
    if (periodDate === null) issue("periodDate", raw.periodDate.trim() ? `"${raw.periodDate}" is not a date (yyyy-MM-dd)` : "date is missing");
    else if (periodDate < batch.periodStart || periodDate > batch.periodEnd) issue("periodDate", `${periodDate} is outside the batch's period ${batch.periodStart} – ${batch.periodEnd}`);
    else {
      const closedIn = closed.find((c) => periodDate >= c.start && periodDate <= c.end);
      if (closedIn) issue("periodDate", `period ${closedIn.key} is closed`);
    }

    const currency = raw.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) issue("currency", currency ? `"${raw.currency}" is not a currency code (e.g. USD)` : "currency is missing");
    const amountText = raw.amount.trim().replace(/,/g, "");
    let amount = "";
    if (!MONEY.test(amountText)) issue("amount", raw.amount.trim() ? `"${raw.amount}" is not an amount (at most 2 decimals, not negative)` : "amount is missing");
    else amount = new Decimal(amountText).toFixed(2);

    if (amount && periodDate && /^[A-Z]{3}$/.test(currency)) {
      const rate = await fx.rate(tx, currency, periodDate);
      if (rate === null) {
        issue("currency", `no FX rate ${currency}→${ws.reportingCurrency} on ${periodDate}`);
        total = null;
      } else {
        const inReporting = new Decimal(amount).mul(rate.rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        reporting.set(rowNo, { amount: inReporting.toFixed(2), fxRateId: rate.id });
        if (total !== null) total = total.plus(inReporting);
      }
      byCurrency.set(currency, (byCurrency.get(currency) ?? new Decimal(0)).plus(amount));
    }

    const kpis: Record<string, string> = {};
    for (const [metric, value] of Object.entries(raw.kpis)) {
      const v = value.trim().replace(/,/g, "");
      if (!v) continue;
      if (!METRIC.test(metric)) issue(`kpi:${metric}`, `"${metric}" is not a metric key`);
      else if (!KPI.test(v)) issue(`kpi:${metric}`, `"${value}" is not a number for ${metric}`);
      else kpis[metric] = new Decimal(v).toString();
    }
    rows.push({ rowNo, dimensionValues: dims, periodDate: periodDate ?? raw.periodDate.trim(), currency, amount: amount || raw.amount.trim(), kpis, ...(raw.note ? { note: raw.note } : {}) });
  }

  // Rows no budget would take land in the unmatched queue: a warning, not a blocker.
  const checkable = rows.filter((r) => !issues.some((i) => i.rowNo === r.rowNo));
  const hits = await tuplesWithEnvelope(tx, ctx.workspaceId, checkable.map((r) => ({ dimensionValues: { ...r.dimensionValues, channel: batch.channel }, periodDate: r.periodDate })));
  const warnings = checkable.filter((_, i) => !hits[i]).map((r) => ({ rowNo: r.rowNo, field: "budget", message: "no budget matches this row; it will wait in the unmatched queue" }));

  return {
    rows,
    issues,
    warnings,
    totals: { amount: total === null ? null : total.toFixed(2), byCurrency: Object.fromEntries([...byCurrency.entries()].map(([c, v]) => [c, v.toFixed(2)])), rows: rows.length },
    reporting,
  };
}
