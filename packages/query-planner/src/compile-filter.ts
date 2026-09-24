import { DomainError, RelativeDate, isPredicate, type FilterGroupT, type Predicate } from "@budget/domain";
import type { SqlBuilder } from "./sql-builder.js";

export interface CompileCtx {
  workspaceId: string;
  periodStart: string;
  periodEnd: string;
  today: string;
}

const invalid = (message: string, p?: Predicate): DomainError =>
  new DomainError("VALIDATION", message, p ? { field: p.field, op: p.op } : undefined);

/** Returns a SQL boolean expression over alias `e` (envelope) and `m` (per-envelope measures CTE). */
export function compileFilter(g: FilterGroupT, b: SqlBuilder, ctx: CompileCtx): string {
  if (g.children.length === 0) return g.not ? "FALSE" : "TRUE";
  const parts = g.children.map((c) => (isPredicate(c) ? compilePredicate(c, b, ctx) : compileFilter(c, b, ctx)));
  const joined = parts.map((p) => `(${p})`).join(g.logic === "and" ? " AND " : " OR ");
  return g.not ? `NOT (${joined})` : joined;
}

/** Metric keys whose per-envelope actual (`m.kpi_<metric>`) the filter reads. */
export function filterMetrics(g: FilterGroupT, out = new Set<string>()): Set<string> {
  for (const c of g.children) {
    if (!isPredicate(c)) filterMetrics(c, out);
    else if (c.field.kind === "target" && (c.field.field === "actual" || c.field.field === "vs_target_pct")) {
      out.add(c.field.metric);
    }
  }
  return out;
}

function compilePredicate(p: Predicate, b: SqlBuilder, ctx: CompileCtx): string {
  switch (p.field.kind) {
    case "dimension":
      return compileDimension(p.field.key, p, b);
    case "measure":
      return compileScalar(`m.${p.field.key}`, p, b, "numeric");
    case "target":
      return compileTarget(p, b);
    case "attr":
      return compileAttr(p, b, ctx);
  }
}

function list(p: Predicate): Array<string | number> {
  if (!Array.isArray(p.value)) throw invalid(`op ${p.op} needs an array value`, p);
  return p.value;
}

function compileDimension(key: string, p: Predicate, b: SqlBuilder): string {
  // Joined through envelope_dimension.dimension_id, so an org-wide dimension of another org with
  // the same key can never be picked (RLS lets every tenant read workspace_id IS NULL rows).
  const base = `EXISTS (SELECT 1 FROM envelope_dimension ed JOIN dimension d ON d.id = ed.dimension_id JOIN dimension_value dv ON dv.id = ed.value_id WHERE ed.envelope_id = e.id AND d.key = ${b.p(key)}::text`;
  switch (p.op) {
    case "eq":
      return `${base} AND dv.code = ${b.p(String(p.value))}::text)`;
    case "neq":
      return `NOT (${base} AND dv.code = ${b.p(String(p.value))}::text))`;
    case "in":
      return `${base} AND dv.code = ANY(${b.p(list(p).map(String))}::text[]))`;
    case "nin":
      return `NOT (${base} AND dv.code = ANY(${b.p(list(p).map(String))}::text[])))`;
    case "contains":
      return `${base} AND dv.label ILIKE ${b.p("%" + String(p.value) + "%")}::text)`;
    case "starts_with":
      return `${base} AND dv.label ILIKE ${b.p(String(p.value) + "%")}::text)`;
    case "is_empty":
      return `NOT (${base}))`;
    case "not_empty":
      return `${base})`;
    case "descends_from":
      // ancestor code → all values whose ltree path is under it
      return `${base} AND dv.path <@ (SELECT x.path FROM dimension_value x WHERE x.dimension_id = dv.dimension_id AND x.code = ${b.p(String(p.value))}::text))`;
    default:
      throw invalid(`op ${p.op} not valid for dimension`, p);
  }
}

/**
 * SQL type of a scalar's bound values. Explicit casts keep the SQL valid for drivers that bind
 * strings as text (Prisma), not only for ones that leave parameters untyped (pg).
 */
type Cast = "numeric" | "text" | "date" | "timestamptz";

function compileScalar(col: string, p: Predicate, b: SqlBuilder, cast: Cast): string {
  const v = (x: unknown) => `${b.p(x)}::${cast}`;
  switch (p.op) {
    case "eq":
      return `${col} = ${v(p.value)}`;
    case "neq":
      return `${col} <> ${v(p.value)}`;
    case "gt":
      return `${col} > ${v(p.value)}`;
    case "gte":
      return `${col} >= ${v(p.value)}`;
    case "lt":
      return `${col} < ${v(p.value)}`;
    case "lte":
      return `${col} <= ${v(p.value)}`;
    case "between": {
      const vals = list(p);
      if (vals.length !== 2) throw invalid("between needs [lo, hi]", p);
      return `${col} BETWEEN ${v(vals[0])} AND ${v(vals[1])}`;
    }
    case "is_empty":
      return `${col} IS NULL`;
    case "not_empty":
      return `${col} IS NOT NULL`;
    case "in":
      return `${col} = ANY(${b.p(list(p).map((x) => (cast === "numeric" ? x : String(x))))}::${cast}[])`;
    default:
      throw invalid(`op ${p.op} not valid for scalar`, p);
  }
}

function compileTarget(p: Predicate, b: SqlBuilder): string {
  if (p.field.kind !== "target") throw new Error("unreachable");
  const metric = p.field.metric;
  // Built only where used: an unreferenced $n makes Postgres reject the statement.
  const t = () => `(SELECT tv.value FROM target t JOIN target_version tv ON tv.id = t.current_version_id
              WHERE t.envelope_id = e.id AND t.metric_key = ${b.p(metric)}::text LIMIT 1)`;
  switch (p.field.field) {
    case "exists":
      if (p.op === "is_empty") return `${t()} IS NULL`;
      if (p.op === "not_empty") return `${t()} IS NOT NULL`;
      throw invalid(`op ${p.op} not valid for target exists`, p);
    case "value":
      return compileScalar(t(), p, b, "numeric");
    case "actual":
      return compileScalar(`m.kpi_${sanitize(metric)}`, p, b, "numeric");
    case "vs_target_pct":
      return compileScalar(`(m.kpi_${sanitize(metric)} / NULLIF(${t()},0))`, p, b, "numeric");
  }
}

function compileAttr(p: Predicate, b: SqlBuilder, ctx: CompileCtx): string {
  if (p.field.kind !== "attr") throw new Error("unreachable");
  switch (p.field.key) {
    case "status":
      return compileScalar(`e.status::text`, p, b, "text");
    case "owner_id":
      return p.op === "eq" && p.value === "@me" ? `e.owner_id = app_user_id()` : compileScalar(`e.owner_id::text`, p, b, "text");
    case "currency":
      return compileScalar(`e.currency::text`, p, b, "text");
    case "name":
      if (p.op === "contains") return `e.name ILIKE ${b.p("%" + String(p.value) + "%")}::text`;
      if (p.op === "starts_with") return `e.name ILIKE ${b.p(String(p.value) + "%")}::text`;
      return compileScalar("e.name", p, b, "text");
    case "tag": {
      if (p.op !== "eq" && p.op !== "in") throw invalid(`op ${p.op} not valid for tag`, p);
      const match = p.op === "in" ? `= ANY(${b.p(list(p).map(String))}::text[])` : `= ${b.p(String(p.value))}::text`;
      return `EXISTS (SELECT 1 FROM taggable tg JOIN tag t ON t.id = tg.tag_id WHERE tg.entity_type='envelope' AND tg.entity_id = e.id AND t.name ${match})`;
    }
    case "has_open_thread":
      if (p.op !== "eq") throw invalid(`op ${p.op} not valid for has_open_thread`, p);
      return `${p.value === false ? "NOT " : ""}EXISTS (SELECT 1 FROM thread th WHERE th.anchor_type='envelope' AND th.anchor_id = e.id AND th.status='open')`;
    case "mentions_user": {
      // '@me' resolves at run time from app.user_id (set by withTenant), so cached SQL stays per-user safe.
      const id = p.value === "@me" ? "app_user_id()::text" : `${b.p(String(p.value))}::text`;
      return `EXISTS (SELECT 1 FROM thread th JOIN comment c ON c.thread_id = th.id WHERE th.anchor_type='envelope' AND th.anchor_id = e.id
                AND c.deleted_at IS NULL AND c.mentions @> jsonb_build_array(jsonb_build_object('type','user','id', ${id})))`;
    }
    case "approver_id":
      return `EXISTS (SELECT 1 FROM approval_request r WHERE r.entity_type='envelope_version' AND r.status='PENDING'
                AND r.entity_id IN (SELECT id FROM envelope_version WHERE envelope_id = e.id)
                AND eligible_approver(r.id, ${p.value === "@me" ? "app_user_id()" : b.p(p.value) + "::uuid"}))`;
    case "alert_severity":
      return `EXISTS (SELECT 1 FROM alert a WHERE a.envelope_id = e.id AND a.status IN ('OPEN','ACKNOWLEDGED') AND ${compileScalar("a.severity", p, b, "text")})`;
    case "created_at":
    case "updated_at":
    case "start_date":
    case "end_date":
      return compileDate(`e.${p.field.key}`, p, b, ctx);
    default:
      throw invalid(`attr ${p.field.key} not supported`, p);
  }
}

/** Postgres has no 'quarter' interval unit. */
const INTERVAL: Record<"day" | "week" | "month" | "quarter" | "year", string> = {
  day: "1 day",
  week: "1 week",
  month: "1 month",
  quarter: "3 months",
  year: "1 year",
};

function compileDate(col: string, p: Predicate, b: SqlBuilder, ctx: CompileCtx): string {
  if (p.op === "within") {
    const parsed = RelativeDate.safeParse(p.value);
    if (!parsed.success) throw invalid("within needs { unit, amount, anchor }", p);
    const r = parsed.data;
    const anchor = r.anchor === "period_start" ? b.p(ctx.periodStart) : r.anchor === "period_end" ? b.p(ctx.periodEnd) : b.p(ctx.today);
    const shifted = `${anchor}::date + ${b.p(r.amount)}::int * interval '${INTERVAL[r.unit]}'`;
    const lo = r.amount < 0 ? shifted : `${anchor}::date`;
    const hi = r.amount < 0 ? `${anchor}::date` : shifted;
    return `${col} BETWEEN ${lo} AND ${hi}`;
  }
  return compileScalar(col, p, b, col.endsWith("_at") ? "timestamptz" : "date");
}

export const sanitize = (s: string) => s.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
