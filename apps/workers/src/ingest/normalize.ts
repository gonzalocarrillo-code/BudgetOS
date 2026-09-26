import { createHash } from "node:crypto";
import type { DimensionColumn, SourceMapping } from "@budget/domain";
import { Decimal } from "decimal.js";
import type { NormalizedFact, RawRow } from "./types.js";

/**
 * One raw row → facts (spec §14 step 2–3). Dimension cells resolve against the registry by code,
 * then alias, then external id (case-sensitive first, then case-insensitive); merged values resolve
 * to the value they were merged into. A row that cannot be resolved is rejected with the reason.
 */

export interface RegistryValue {
  code: string;
  aliases: string[];
  externalIds: string[];
  /** Code this value was merged into, or null. */
  mergedInto: string | null;
  isActive: boolean;
}

type Via = "code" | "alias" | "external_id";

export class RegistryIndex {
  private readonly exact = new Map<string, Map<string, { v: RegistryValue; via: Via }>>();
  private readonly folded = new Map<string, Map<string, { v: RegistryValue; via: Via }>>();

  constructor(dimensions: Map<string, RegistryValue[]>) {
    for (const [key, values] of dimensions) {
      const exact = new Map<string, { v: RegistryValue; via: Via }>();
      const folded = new Map<string, { v: RegistryValue; via: Via }>();
      // Codes win over aliases, aliases over external ids.
      const picks: Array<[Via, (v: RegistryValue) => string[]]> = [["code", (v) => [v.code]], ["alias", (v) => v.aliases], ["external_id", (v) => v.externalIds]];
      for (const [via, pick] of picks) {
        for (const v of values) {
          for (const name of pick(v)) {
            if (!exact.has(name)) exact.set(name, { v, via });
            if (!folded.has(name.toLowerCase())) folded.set(name.toLowerCase(), { v, via });
          }
        }
      }
      this.exact.set(key, exact);
      this.folded.set(key, folded);
    }
  }

  has(dimension: string): boolean {
    return this.exact.has(dimension);
  }

  /** The registry code for a raw value (and whether it was an external id, §24.3 step 1), or an error message. */
  resolve(dimension: string, raw: string): { code: string; via: Via } | { error: string } {
    const hit = this.exact.get(dimension)?.get(raw) ?? this.folded.get(dimension)?.get(raw.toLowerCase());
    if (hit === undefined) return { error: `unknown ${dimension} "${raw}"` };
    const { v, via } = hit;
    if (v.mergedInto !== null) return { code: v.mergedInto, via };
    if (!v.isActive) return { error: `${dimension} "${raw}" is retired` };
    return { code: v.code, via };
  }
}

/**
 * §24.3 step 2: the envelopes' match keys (lower-cased → the envelope's tuple) and the source's
 * parse pattern (named groups are dimension keys). A match key resolves the fact's tuple to that
 * envelope's; a parse pattern reads dimension values out of the key.
 */
export interface MatchKeys {
  envelopes: Map<string, Record<string, string>>;
  pattern: RegExp | null;
}

export type NormalizeResult = { facts: NormalizedFact[] } | { rejected: string };

const cell = (v: string | number | null | undefined): string | null => (v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim());

function transform(value: string, c: DimensionColumn): string {
  const t = c.transform === "lower" ? value.toLowerCase() : c.transform === "upper" ? value.toUpperCase() : value;
  return c.valueMap?.[t] ?? c.valueMap?.[value] ?? t;
}

/** A date cell in the mapping's format → yyyy-MM-dd; `yyyy-MM` is the first of the month. */
export function parseDate(raw: string, format: "yyyy-MM-dd" | "yyyy-MM" | "dd/MM/yyyy" | "MM/dd/yyyy"): string | null {
  let y: string | undefined, m: string | undefined, d: string | undefined;
  const parts = (re: RegExp) => re.exec(raw)?.slice(1) ?? [];
  switch (format) {
    case "yyyy-MM-dd":
      [y, m, d] = parts(/^(\d{4})-(\d{2})-(\d{2})/); // a trailing time is ignored
      break;
    case "yyyy-MM":
      [y, m] = parts(/^(\d{4})-(\d{2})$/);
      d = "01";
      break;
    case "dd/MM/yyyy":
      [d, m, y] = parts(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      break;
    case "MM/dd/yyyy":
      [m, d, y] = parts(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      break;
  }
  if (!y || !m || !d) return null;
  const iso = `${y}-${m}-${d}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso ? null : iso;
}

/** Decimal cell (a JS number from a warehouse, or text); thousands separators are not accepted. */
function parseNumber(raw: string | number, dp: number): string | null {
  const s = typeof raw === "number" ? String(raw) : raw.trim();
  if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) return null;
  return new Decimal(s).toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toFixed(dp);
}

/** sha256(sourceId + JSON of the row with sorted keys) (spec §14 step 3); KPI facts add the metric. */
export function rowHash(sourceId: string, row: RawRow, suffix = ""): string {
  const sorted = Object.fromEntries(Object.keys(row).sort().map((k) => [k, row[k] ?? null]));
  return createHash("sha256").update(sourceId + JSON.stringify(sorted) + suffix).digest("hex");
}

export function normalize(row: RawRow, mapping: SourceMapping, registry: RegistryIndex, sourceId: string, keys: MatchKeys = { envelopes: new Map(), pattern: null }): NormalizeResult {
  let dimensionValues: Record<string, string> = {};
  let viaExternalId = false;
  let matchKey: string | null = null;
  let periodDate: string | null = null;
  let amount: string | null = null;
  let currency: string | null = null;
  let formulaVersion: string | null = null;
  let horizonEnd: string | null = null;
  const kpis: Array<{ metric: string; value: string; attributionModel?: string }> = [];
  let projection: { metric: string; value: string } | null = null;

  for (const [column, c] of Object.entries(mapping.columns)) {
    const raw = row[column];
    const v = cell(raw);
    if ("dimension" in c) {
      if (v === null) continue; // an empty cell leaves the dimension out of the tuple
      const resolved = registry.resolve(c.dimension, transform(v, c));
      if ("error" in resolved) return { rejected: resolved.error };
      dimensionValues[c.dimension] = resolved.code;
      if (resolved.via === "external_id") viaExternalId = true;
      continue;
    }
    switch (c.role) {
      case "period_date":
        if (v === null) return { rejected: `missing ${column}` };
        periodDate = parseDate(v, c.format);
        if (periodDate === null) return { rejected: `${column} "${v}" is not ${c.format}` };
        break;
      case "amount":
        if (v === null) break;
        amount = parseNumber(typeof raw === "number" ? raw : v, 2);
        if (amount === null) return { rejected: `${column} "${v}" is not a number` };
        currency ??= c.currency ?? null;
        break;
      case "currency":
        if (v !== null) {
          if (!/^[A-Za-z]{3}$/.test(v)) return { rejected: `${column} "${v}" is not a currency code` };
          currency = v.toUpperCase();
        }
        break;
      case "kpi": {
        if (v === null) break;
        const value = parseNumber(typeof raw === "number" ? raw : v, 4);
        if (value === null) return { rejected: `${column} "${v}" is not a number` };
        kpis.push({ metric: c.metric, value, ...(c.attributionModel ? { attributionModel: c.attributionModel } : {}) });
        break;
      }
      case "projection": {
        if (v === null) break;
        const value = parseNumber(typeof raw === "number" ? raw : v, 4);
        if (value === null) return { rejected: `${column} "${v}" is not a number` };
        projection = { metric: c.metric, value };
        break;
      }
      case "formula_version":
        formulaVersion = v;
        break;
      case "horizon_end":
        if (v !== null) {
          horizonEnd = parseDate(v, "yyyy-MM-dd");
          if (horizonEnd === null) return { rejected: `${column} "${v}" is not yyyy-MM-dd` };
        }
        break;
      case "match_key":
        matchKey = v;
        break;
      case "ignore":
        break;
    }
  }
  if (periodDate === null) return { rejected: "no period date" };
  // §24.3: 1. external ids resolved above; 2. the match key (parsed, or looked up); 3. the tuple (in the match).
  let viaMatchKey = false;
  if (matchKey !== null) {
    if (keys.pattern) {
      const groups = keys.pattern.exec(matchKey)?.groups;
      for (const [k, raw] of Object.entries(groups ?? {})) {
        if (raw === undefined || dimensionValues[k] !== undefined) continue;
        const resolved = registry.resolve(k, raw);
        if ("error" in resolved) return { rejected: `${resolved.error} (from the match key "${matchKey}")` };
        dimensionValues[k] = resolved.code;
        viaMatchKey = true;
      }
    } else {
      const tuple = keys.envelopes.get(matchKey.toLowerCase());
      if (tuple) {
        dimensionValues = { ...dimensionValues, ...tuple };
        viaMatchKey = true;
      }
    }
  }
  // A row with an unknown match key and no dimensions is unmatched, not rejected: the queue shows it.
  if (Object.keys(dimensionValues).length === 0 && matchKey === null) return { rejected: "no dimension values" };
  const matchHint = viaExternalId ? ("external_id" as const) : viaMatchKey ? ("match_key" as const) : undefined;

  const facts: NormalizedFact[] = [];
  const base = { dimensionValues, periodDate, ...(matchHint ? { matchHint } : {}) };
  if (mapping.kind === "spend" || mapping.kind === "spend+kpi") {
    if (amount !== null) {
      if (currency === null) return { rejected: "no currency for the amount" };
      facts.push({ kind: "spend", ...base, currency, amount, rowHash: rowHash(sourceId, row) });
    } else if (mapping.kind === "spend") return { rejected: "missing amount" };
  }
  if (mapping.kind === "kpi" || mapping.kind === "spend+kpi") {
    for (const k of kpis) facts.push({ kind: "kpi", ...base, metric: k.metric, value: k.value, ...(k.attributionModel ? { attributionModel: k.attributionModel } : {}), rowHash: rowHash(sourceId, row, `:${k.metric}`) });
  }
  if (mapping.kind === "projection") {
    if (projection === null) return { rejected: "missing projection value" };
    if (formulaVersion === null || horizonEnd === null) return { rejected: "missing formula_version or horizon_end" };
    facts.push({ kind: "projection", ...base, metric: projection.metric, value: projection.value, formulaVersion, horizonEnd, rowHash: rowHash(sourceId, row) });
  }
  if (facts.length === 0) return { rejected: "no values in the row" };
  return { facts };
}
