import { Decimal } from "decimal.js";
import { DomainError } from "./errors.js";

/**
 * Splits `total` over `weights` so the parts sum to `total` to the cent: floor each share, then
 * give the leftover cents to the largest remainders (ties: input order). All-zero weights split
 * evenly. Shared by bulk edit, split, and the golden plan so they agree to the cent.
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
  const parts = largestRemainder(amount, phasing.map((p) => p.amount.abs()));
  return phasing.map((p, i) => ({ month: p.month, amount: parts[i] as Decimal }));
}
