import { DomainError, type ParsedSearch, type ScopeFilter } from "@budget/domain";
import { SqlBuilder } from "./sql-builder.js";

/**
 * Search query over search_document (spec §12.3). Top `limitPerType` hits per entity type with a
 * per-type count. Qualifiers are the spec's set; any other key is a registry dimension key.
 * `scopes` are the caller's dimension scopes for reading envelopes (null = unrestricted): documents
 * of scoped types must match one of them; tags and registry values are workspace-wide.
 */

export const SEARCH_TYPES = ["envelope", "target", "approval_request", "alert", "comment", "tag", "dimension_value"] as const;
const TYPE_ALIASES: Record<string, string> = { approval: "approval_request", request: "approval_request", value: "dimension_value", dimension: "dimension_value" };
const WORKSPACE_WIDE = ["tag", "dimension_value"];
const NUMERIC: Record<string, string> = { budget: "budget", actual: "actual", cpa: "cpa", pace: "pace_index", target: "target" };

export interface SearchContext {
  workspaceId: string;
  userId: string;
  scopes: ScopeFilter[] | null;
  limitPerType: number;
}

export interface CompiledSearch {
  sql: string;
  values: unknown[];
  types: string[];
}

const invalid = (message: string, details?: Record<string, unknown>) => new DomainError("VALIDATION", message, details);

/** `<7d`, `>2w`, `<12h`, `<3m` → a Postgres interval. */
export function parseRelative(value: string): string {
  const m = /^(\d{1,4})([hdwm])$/.exec(value);
  if (!m) throw invalid(`updated needs <Nd, <Nw, <Nh or <Nm, got ${value}`);
  const unit = { h: "hours", d: "days", w: "weeks", m: "months" }[m[2] as "h" | "d" | "w" | "m"];
  return `${m[1]} ${unit}`;
}

export function searchTypes(types: string[]): string[] {
  const out = types.map((t) => TYPE_ALIASES[t] ?? t);
  const unknown = out.filter((t) => !(SEARCH_TYPES as readonly string[]).includes(t));
  if (unknown.length) throw invalid("Unknown search types", { unknown, allowed: SEARCH_TYPES });
  return [...new Set(out)];
}

type ScopeNode = { logic: "and" | "or"; not?: boolean | undefined; children: ScopeNode[] } | { field: { kind: "dimension"; key: string }; op: "eq" | "in" | "descends_from"; value: string | string[] };

function scopeSql(node: ScopeNode, b: SqlBuilder): string {
  if ("children" in node) {
    if (node.children.length === 0) return node.not ? "FALSE" : "TRUE";
    const joined = node.children.map((c) => `(${scopeSql(c, b)})`).join(node.logic === "and" ? " AND " : " OR ");
    return node.not ? `NOT (${joined})` : joined;
  }
  const key = b.p(node.field.key);
  const col = `dimension_values->>${key}::text`;
  const values = Array.isArray(node.value) ? node.value : [node.value];
  switch (node.op) {
    case "eq":
    case "in":
      return `${col} = ANY(${b.p(values)}::text[])`;
    case "descends_from":
      // The value and every value under it in the registry tree (ltree path), like matchesScope.
      return `${col} IN (SELECT dv.code FROM dimension_value dv JOIN dimension di ON di.id = dv.dimension_id
                WHERE di.key = ${key}::text AND EXISTS (SELECT 1 FROM dimension_value x WHERE x.dimension_id = dv.dimension_id
                  AND x.code = ANY(${b.p(values)}::text[]) AND dv.path <@ x.path))`;
  }
}

export function compileSearch(parsed: ParsedSearch, ctx: SearchContext): CompiledSearch {
  const b = new SqlBuilder();
  const conds: string[] = [`workspace_id = ${b.p(ctx.workspaceId)}::uuid`];
  const types = searchTypes(parsed.types);
  if (types.length) conds.push(`entity_type = ANY(${b.p(types)}::text[])`);
  if (ctx.scopes !== null) {
    const allowed = ctx.scopes.map((s) => ("children" in s ? scopeSql(s as ScopeNode, b) : "TRUE"));
    conds.push(`(entity_type = ANY(${b.p(WORKSPACE_WIDE)}::text[]) OR ${allowed.length ? allowed.map((a) => `(${a})`).join(" OR ") : "FALSE"})`);
  }
  for (const q of parsed.qualifiers) {
    switch (q.key) {
      case "tag":
        conds.push(`${q.op === "neq" ? "NOT " : ""}(${b.p(q.value)}::text = ANY(tags))`);
        break;
      case "status":
        conds.push(`status ${q.op === "neq" ? "IS DISTINCT FROM" : "="} ${b.p(q.value.toUpperCase())}::text`);
        break;
      case "owner":
        conds.push(
          `${q.op === "neq" ? "owner_id IS DISTINCT FROM" : "owner_id ="} ${q.value === "@me" ? `${b.p(ctx.userId)}::uuid` : `(SELECT id FROM app_user WHERE email ILIKE ${b.p(`${q.value}%`)}::text ORDER BY email LIMIT 1)`}`,
        );
        break;
      case "period":
        conds.push(`period_key ${q.op === "neq" ? "IS DISTINCT FROM" : "="} ${b.p(q.value)}::text`);
        break;
      case "budget":
      case "actual":
      case "cpa":
      case "pace": {
        const facet = `(numeric_facets->>${b.p(NUMERIC[q.key])}::text)::numeric`;
        const cmp = q.op === "gt" ? ">" : q.op === "lt" ? "<" : q.op === "neq" ? "<>" : "=";
        if (q.key === "cpa" && q.value === "target") {
          conds.push(`${facet} ${cmp} (numeric_facets->>'cpa_target')::numeric`);
        } else {
          if (!/^-?\d+(\.\d+)?$/.test(q.value)) throw invalid(`${q.key} needs a number`, { value: q.value });
          conds.push(`${facet} ${cmp} ${b.p(q.value)}::numeric`);
        }
        break;
      }
      case "has":
        if (q.value !== "open-thread") throw invalid("has supports open-thread", { value: q.value });
        conds.push(`${q.op === "neq" ? "NOT " : ""}(entity_id IN (SELECT t.anchor_id FROM thread t WHERE t.workspace_id = ${b.p(ctx.workspaceId)}::uuid AND t.status = 'open'))`);
        break;
      case "mentions":
        if (q.value !== "@me") throw invalid("mentions supports @me", { value: q.value });
        conds.push(`entity_type = 'comment' AND entity_id IN (SELECT c.id FROM comment c WHERE c.deleted_at IS NULL AND c.mentions @> ${b.p(JSON.stringify([{ type: "user", id: ctx.userId }]))}::jsonb)`);
        break;
      case "updated":
        conds.push(`updated_at ${q.op === "gt" ? "<" : ">"} now() - ${b.p(parseRelative(q.value))}::interval`);
        break;
      default: // any registry dimension key: dimension_values ->> key, case-insensitive
        conds.push(`lower(dimension_values->>${b.p(q.key)}::text) ${q.op === "neq" ? "IS DISTINCT FROM" : "="} lower(${b.p(q.value)}::text)`);
    }
  }
  const hasText = parsed.text.length > 0;
  const tsq = hasText ? `websearch_to_tsquery('simple', ${b.p(parsed.text)}::text)` : null;
  const trg = hasText ? `${b.p(parsed.text.toLowerCase())}::text` : null;
  if (hasText) conds.push(`(tsv @@ ${tsq} OR trigram % ${trg} OR trigram LIKE ${b.p(`%${parsed.text.toLowerCase()}%`)}::text)`);
  const rank = hasText ? `(ts_rank_cd(tsv, ${tsq}) * 2 + similarity(trigram, ${trg}))` : `extract(epoch from updated_at) / 1e12`;
  const sql = `
    SELECT * FROM (
      SELECT entity_type, entity_id::text AS entity_id, title, path, status, numeric_facets, dimension_values, updated_at, ${rank} AS rank,
             row_number() OVER (PARTITION BY entity_type ORDER BY ${rank} DESC, updated_at DESC, entity_id) AS rn,
             count(*) OVER (PARTITION BY entity_type) AS type_count
      FROM search_document WHERE ${conds.join(" AND ")}
    ) x WHERE rn <= ${b.p(ctx.limitPerType)}::int ORDER BY entity_type, rank DESC, rn`;
  return { sql, values: b.values, types };
}
