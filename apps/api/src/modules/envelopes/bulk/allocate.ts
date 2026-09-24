import { DomainError, type BulkOperation } from "@budget/domain";
import { Decimal } from "decimal.js";

/** Pure bulk-edit math (plan §9.3). Everything is Decimal at 2 dp; totals always sum exactly. */

export interface AllocRow {
  envelopeId: string;
  currency: string;
  before: Decimal | null; // head amount (draft ?? approved), envelope currency
}

export interface AllocContext {
  /** redistribute: the parent's approved amount (envelope currency) when `total` is not given. */
  parentAmount?: Decimal | null;
  parentCurrency?: string;
  /** redistribute by_last_actuals: actual spend to date per envelope. */
  actuals?: Map<string, Decimal>;
  /** copy_previous_period: previous envelope's approved amount and currency. */
  previous?: Map<string, { amount: Decimal | null; currency: string }>;
}

export interface AllocResult {
  after: Map<string, Decimal>;
  skipped: Array<{ envelopeId: string; reason: string }>;
}

const cents = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/**
 * Splits `total` over `weights` so the parts sum to `total` to the cent: floor each share, then
 * give the leftover cents to the largest remainders (ties: input order). Zero weights everywhere
 * split evenly.
 */
export function largestRemainder(total: Decimal, weights: Decimal[]): Decimal[] {
  if (weights.length === 0) return [];
  if (weights.some((w) => w.isNegative())) throw new DomainError("VALIDATION", "Weights must not be negative");
  const sum = weights.reduce((s, w) => s.plus(w), new Decimal(0));
  const ws = sum.isZero() ? weights.map(() => new Decimal(1)) : weights;
  const wsum = sum.isZero() ? new Decimal(weights.length) : sum;
  const totalCents = total.mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  const sign = totalCents.isNegative() ? -1 : 1;
  const abs = totalCents.abs();
  const raw = ws.map((w) => abs.mul(w).div(wsum));
  const floors = raw.map((r) => r.floor());
  let left = abs.minus(floors.reduce((s, f) => s.plus(f), new Decimal(0))).toNumber();
  const order = raw.map((r, i) => ({ i, frac: r.minus(r.floor()) })).sort((a, b) => b.frac.comparedTo(a.frac) || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] = (floors[i] as Decimal).plus(1);
    left -= 1;
  }
  return floors.map((f) => f.mul(sign).div(100));
}

/** Re-scales a monthly phasing to a new amount, keeping its shape and summing exactly. */
export function rephase(phasing: Array<{ month: string; amount: Decimal }>, amount: Decimal): Array<{ month: string; amount: Decimal }> {
  if (phasing.length === 0) return [];
  const weights = phasing.map((p) => p.amount.abs());
  const parts = largestRemainder(amount, weights);
  return phasing.map((p, i) => ({ month: p.month, amount: parts[i] as Decimal }));
}

function singleCurrency(rows: AllocRow[], what: string): string {
  const currencies = new Set(rows.map((r) => r.currency));
  if (currencies.size > 1) throw new DomainError("VALIDATION", `${what} needs envelopes in one currency`, { currencies: [...currencies] });
  return rows[0]?.currency ?? "";
}

export function allocate(rows: AllocRow[], op: BulkOperation, ctx: AllocContext = {}): AllocResult {
  const after = new Map<string, Decimal>();
  const skipped: AllocResult["skipped"] = [];
  const base = (r: AllocRow) => r.before ?? new Decimal(0);
  switch (op.op) {
    case "set":
      for (const r of rows) after.set(r.envelopeId, new Decimal(op.amount));
      break;
    case "add":
      for (const r of rows) after.set(r.envelopeId, cents(base(r).plus(op.amount)));
      break;
    case "pct":
      for (const r of rows) after.set(r.envelopeId, cents(base(r).mul(new Decimal(100).plus(op.pct)).div(100)));
      break;
    case "scale_to_total": {
      singleCurrency(rows, "scale_to_total");
      const parts = largestRemainder(new Decimal(op.total), rows.map(base));
      rows.forEach((r, i) => after.set(r.envelopeId, parts[i] as Decimal));
      break;
    }
    case "redistribute": {
      const currency = singleCurrency(rows, "redistribute");
      let total: Decimal;
      if (op.total !== undefined) total = new Decimal(op.total);
      else {
        if (ctx.parentAmount === null || ctx.parentAmount === undefined) throw new DomainError("VALIDATION", "Parent has no approved amount; pass total");
        if (ctx.parentCurrency !== undefined && ctx.parentCurrency !== currency) throw new DomainError("VALIDATION", "Parent and children use different currencies; pass total");
        total = ctx.parentAmount;
      }
      let weights: Decimal[];
      switch (op.method) {
        case "proportional":
          weights = rows.map(base);
          break;
        case "even":
          weights = rows.map(() => new Decimal(1));
          break;
        case "by_last_actuals":
          weights = rows.map((r) => ctx.actuals?.get(r.envelopeId) ?? new Decimal(0));
          if (weights.every((w) => w.isZero())) throw new DomainError("VALIDATION", "No actuals to redistribute by");
          break;
        case "by_weights": {
          const missing = rows.filter((r) => op.weights?.[r.envelopeId] === undefined).map((r) => r.envelopeId);
          if (missing.length) throw new DomainError("VALIDATION", "Weights missing for some envelopes", { missing });
          weights = rows.map((r) => new Decimal(op.weights?.[r.envelopeId] ?? 0));
          break;
        }
      }
      const parts = largestRemainder(total, weights);
      rows.forEach((r, i) => after.set(r.envelopeId, parts[i] as Decimal));
      break;
    }
    case "copy_previous_period":
      for (const r of rows) {
        const prev = ctx.previous?.get(r.envelopeId);
        if (!prev || prev.amount === null) skipped.push({ envelopeId: r.envelopeId, reason: "no approved previous period with the same dimensions" });
        else if (prev.currency !== r.currency) skipped.push({ envelopeId: r.envelopeId, reason: `previous period is in ${prev.currency}` });
        else after.set(r.envelopeId, cents(prev.amount.mul(op.factor)));
      }
      break;
    case "paste": {
      const byId = new Map(op.rows.map((p) => [p.envelopeId, new Decimal(p.amount)]));
      if (byId.size !== op.rows.length) throw new DomainError("VALIDATION", "Paste has the same envelope twice");
      for (const r of rows) {
        const v = byId.get(r.envelopeId);
        if (v !== undefined) after.set(r.envelopeId, v);
      }
      break;
    }
  }
  return { after, skipped };
}
