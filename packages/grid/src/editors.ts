import { Decimal } from "decimal.js";

const MONEY = /^(-?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?([kKmMbB])?$/;
const PERCENT = /^(-?)(\d+)(?:\.(\d+))?%?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export type EditorAction =
  | { type: "commit" }
  | { type: "cancel" }
  | { type: "move"; movement: readonly [-1 | 0 | 1, -1 | 0 | 1] }
  | { type: "type" };

export function editorAction(key: string, shift: boolean): EditorAction {
  if (key === "Enter") return { type: "commit" };
  if (key === "Escape") return { type: "cancel" };
  if (key === "Tab") return { type: "move", movement: shift ? [-1, 0] : [1, 0] };
  return { type: "type" };
}

export function parseMoney(input: string): string | null {
  const match = MONEY.exec(input.trim().replace(/[$€£¥\s]/g, ""));
  if (match === null) return null;
  const sign = match[1] === "-" ? "-" : "";
  const whole = match[2]?.replace(/,/g, "");
  if (whole === undefined || whole.length === 0) return null;
  const fraction = match[3] ?? "";
  const suffix = match[4]?.toLowerCase();
  const multiplier = suffix === "k" ? "1000" : suffix === "m" ? "1000000" : suffix === "b" ? "1000000000" : "1";
  const numeric = new Decimal(`${sign}${whole}${fraction.length > 0 ? `.${fraction}` : ""}`).mul(multiplier);
  if (!numeric.isFinite()) return null;
  return numeric.toFixed(2);
}

export function formatMoney(value: string, currency: string): string {
  const fixed = new Decimal(value).toFixed(2);
  const negative = fixed.startsWith("-");
  const digits = negative ? fixed.slice(1) : fixed;
  const split = digits.split(".");
  const whole = split[0] ?? "0";
  const fraction = split[1] ?? "00";
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${currency} ${grouped}.${fraction}`;
}

/** A change of money, signed: "+USD 300.00", "-USD 500.00", "USD 0.00" (Phase E compare columns). */
export function formatChange(value: string, currency: string): string {
  const d = new Decimal(value);
  return `${d.gt(0) ? "+" : ""}${formatMoney(value, currency)}`;
}

/** A ratio as a signed percent with one decimal: 0.032 → "+3.2%", -0.7143 → "-71.4%". */
export function formatPctChange(value: string): string {
  const pct = new Decimal(value).mul(100).toDecimalPlaces(1);
  return `${pct.gt(0) ? "+" : ""}${pct.toFixed(1)}%`;
}

export function parsePercent(input: string): string | null {
  const match = PERCENT.exec(input.trim());
  if (match === null) return null;
  const sign = match[1] === "-" ? "-" : "";
  const whole = match[2];
  if (whole === undefined) return null;
  const fraction = match[3] ?? "";
  return new Decimal(`${sign}${whole}${fraction.length > 0 ? `.${fraction}` : ""}`).toFixed(2);
}

export function parseDate(input: string): string | null {
  const match = ISO_DATE.exec(input);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return null;
  return input;
}
