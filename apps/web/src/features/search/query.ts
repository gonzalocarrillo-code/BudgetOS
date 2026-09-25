import { parseSearch, type FilterGroupT, type Predicate } from "@budget/domain";

/**
 * Search box helpers (spec §18.4). The last token is what autocomplete completes: a qualifier key
 * (`reg` → `region:`) or, after the colon, one of its values (`region:la` → `region:LATAM`).
 */
export function lastToken(q: string): string {
  const m = /(\S*)$/.exec(q);
  return m?.[1] ?? "";
}

/** Replaces the last token; a completed key keeps the caret after its colon, a value adds a space. */
export function replaceLastToken(q: string, replacement: string): string {
  return `${q.slice(0, q.length - lastToken(q).length)}${replacement}${replacement.endsWith(":") ? "" : " "}`;
}

/** The token is a qualifier being typed (letters, then optionally `:` and a partial value). */
export function isQualifierToken(token: string): boolean {
  return /^-?[a-z_]+(:[^\s]*)?$/i.test(token) && (token.includes(":") || token.length >= 2);
}

/** Dimension qualifiers of a search as an Explorer FilterGroup (⇧Enter opens the Explorer with it). */
export function qualifiersAsFilter(q: string, dimensionKeys: ReadonlySet<string>): FilterGroupT {
  const children: Predicate[] = [];
  for (const qual of parseSearch(q).qualifiers) {
    if (!dimensionKeys.has(qual.key)) continue;
    if (qual.op === "eq") children.push({ field: { kind: "dimension", key: qual.key }, op: "eq", value: qual.value });
    if (qual.op === "neq") children.push({ field: { kind: "dimension", key: qual.key }, op: "neq", value: qual.value });
  }
  return { logic: "and", children };
}
