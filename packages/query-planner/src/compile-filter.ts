// packages/query-planner/src/compile-filter.ts
import { isPredicate, type FilterGroupT, type Predicate } from "@budget/domain";
import { SqlBuilder } from "./sql-builder.js";

/** Returns a SQL boolean expression over alias `e` (envelope) and `m` (per-envelope measures CTE). */
export function compileFilter(g: FilterGroupT, b: SqlBuilder, ctx: CompileCtx): string {
  if (g.children.length === 0) return "TRUE";
  const parts = g.children.map((c) => (isPredicate(c) ? compilePredicate(c, b, ctx) : compileFilter(c, b, ctx)));
  const joined = parts.map((p) => `(${p})`).join(g.logic === "and" ? " AND " : " OR ");
  return g.not ? `NOT (${joined})` : joined;
}

export interface CompileCtx {
  workspaceId: string;
  periodStart: string;
  periodEnd: string;
  today: string;
}

function compilePredicate(p: Predicate, b: SqlBuilder, ctx: CompileCtx): string {
  switch (p.field.kind) {
    case "dimension":
      return compileDimension(p.field.key, p, b, ctx);
    case "measure":
      return compileScalar(`m.${p.field.key}`, p, b);
    case "target":
      return compileTarget(p, b);
    case "attr":
      return compileAttr(p, b, ctx);
  }
}

function compileDimension(key: string, p: Predicate, b: SqlBuilder, ctx: CompileCtx): string {
  const dimSub = `SELECT d.id FROM dimension d WHERE d.key = ${b.p(key)} AND (d.workspace_id = ${b.p(ctx.workspaceId)}::uuid OR d.workspace_id IS NULL) ORDER BY d.workspace_id NULLS LAST LIMIT 1`;
  const base = `EXISTS (SELECT 1 FROM envelope_dimension ed JOIN dimension_value dv ON dv.id = ed.value_id WHERE ed.envelope_id = e.id AND ed.dimension_id = (${dimSub})`;
  switch (p.op) {
    case "eq":
      return `${base} AND dv.code = ${b.p(p.value)})`;
    case "neq":
      return `NOT (${base} AND dv.code = ${b.p(p.value)}))`;
    case "in":
      return `${base} AND dv.code = ANY(${b.p(p.value)}::text[]))`;
    case "nin":
      return `NOT (${base} AND dv.code = ANY(${b.p(p.value)}::text[])))`;
    case "contains":
      return `${base} AND dv.label ILIKE ${b.p("%" + String(p.value) + "%")})`;
    case "starts_with":
      return `${base} AND dv.label ILIKE ${b.p(String(p.value) + "%")})`;
    case "is_empty":
      return `NOT (${base}))`;
    case "not_empty":
      return `${base})`;
    case "descends_from":
      // ancestor code → all values whose ltree path is under it
      return `${base} AND dv.path <@ (SELECT path FROM dimension_value x WHERE x.dimension_id = dv.dimension_id AND x.code = ${b.p(p.value)}))`;
    default:
      throw new Error(`op ${p.op} not valid for dimension`);
  }
}

function compileScalar(col: string, p: Predicate, b: SqlBuilder): string {
  switch (p.op) {
    case "eq":
      return `${col} = ${b.p(p.value)}`;
    case "neq":
      return `${col} <> ${b.p(p.value)}`;
    case "gt":
      return `${col} > ${b.p(p.value)}`;
    case "gte":
      return `${col} >= ${b.p(p.value)}`;
    case "lt":
      return `${col} < ${b.p(p.value)}`;
    case "lte":
      return `${col} <= ${b.p(p.value)}`;
    case "between": {
      const [lo, hi] = p.value as [number, number];
      return `${col} BETWEEN ${b.p(lo)} AND ${b.p(hi)}`;
    }
    case "is_empty":
      return `${col} IS NULL`;
    case "not_empty":
      return `${col} IS NOT NULL`;
    case "in":
      return `${col} = ANY(${b.p(p.value)})`;
    default:
      throw new Error(`op ${p.op} not valid for scalar`);
  }
}

function compileTarget(p: Predicate, b: SqlBuilder): string {
  if (p.field.kind !== "target") throw new Error("unreachable");
  const metric = p.field.metric;
  // Bind the metric parameter only when this subquery is embedded. Building it for
  // `actual` leaves an unused parameter, which Postgres rejects.
  const targetValue = (): string =>
    `(SELECT tv.value FROM target t JOIN target_version tv ON tv.id = t.current_version_id
              WHERE t.envelope_id = e.id AND t.metric_key = ${b.p(metric)} LIMIT 1)`;
  switch (p.field.field) {
    case "exists": {
      const t = targetValue();
      return p.op === "is_empty" ? `${t} IS NULL` : `${t} IS NOT NULL`;
    }
    case "value":
      return compileScalar(targetValue(), p, b);
    case "actual":
      return compileScalar(`m.kpi_${sanitize(metric)}`, p, b);
    case "vs_target_pct": {
      const t = targetValue();
      return compileScalar(`(m.kpi_${sanitize(metric)} / NULLIF(${t},0))`, p, b);
    }
  }
}

function compileAttr(p: Predicate, b: SqlBuilder, ctx: CompileCtx): string {
  if (p.field.kind !== "attr") throw new Error("unreachable");
  switch (p.field.key) {
    case "status":
      return compileScalar(`e.status::text`, p, b);
    case "owner_id":
      return p.value === "@me" ? `e.owner_id = app_user_id()` : compileScalar(`e.owner_id::text`, p, b);
    case "currency":
      return compileScalar(`e.currency`, p, b);
    case "name":
      return p.op === "contains" ? `e.name ILIKE ${b.p("%" + String(p.value) + "%")}` : compileScalar("e.name", p, b);
    case "tag":
      return `EXISTS (SELECT 1 FROM taggable tg JOIN tag t ON t.id = tg.tag_id WHERE tg.entity_type='envelope' AND tg.entity_id = e.id AND t.name ${p.op === "in" ? `= ANY(${b.p(p.value)}::text[])` : `= ${b.p(p.value)}`})`;
    case "has_open_thread":
      return `${p.value === false ? "NOT " : ""}EXISTS (SELECT 1 FROM thread th WHERE th.anchor_type='envelope' AND th.anchor_id = e.id AND th.status='open')`;
    case "mentions_user":
      return `EXISTS (SELECT 1 FROM thread th JOIN comment c ON c.thread_id = th.id WHERE th.anchor_type='envelope' AND th.anchor_id = e.id AND c.mentions @> ${b.p(JSON.stringify([{ type: "user", id: p.value === "@me" ? "__ME__" : p.value }]))}::jsonb)`.replace(
        '"__ME__"',
        `' || app_user_id()::text || '`,
      ); // resolved at runtime via app_user_id()
    case "approver_id":
      return `EXISTS (SELECT 1 FROM approval_request r WHERE r.entity_type='envelope_version' AND r.status='PENDING'
                AND r.entity_id IN (SELECT id FROM envelope_version WHERE envelope_id = e.id)
                AND eligible_approver(r.id, ${p.value === "@me" ? "app_user_id()" : b.p(p.value) + "::uuid"}))`;
    case "alert_severity":
      return `EXISTS (SELECT 1 FROM alert a WHERE a.envelope_id = e.id AND a.status IN ('OPEN','ACKNOWLEDGED') AND a.severity = ${b.p(p.value)})`;
    case "created_at":
    case "updated_at":
    case "start_date":
    case "end_date":
      return compileDate(`e.${p.field.key}`, p, b, ctx);
    default:
      throw new Error(`attr ${p.field.key} not supported`);
  }
}

function compileDate(col: string, p: Predicate, b: SqlBuilder, ctx: CompileCtx): string {
  if (p.op === "within") {
    const r = p.value as { unit: string; amount: number; anchor: string };
    const anchor = r.anchor === "period_start" ? b.p(ctx.periodStart) : r.anchor === "period_end" ? b.p(ctx.periodEnd) : b.p(ctx.today);
    const lo = r.amount < 0 ? `${anchor}::date + (${b.p(r.amount)} || ' ${r.unit}')::interval` : `${anchor}::date`;
    const hi = r.amount < 0 ? `${anchor}::date` : `${anchor}::date + (${b.p(r.amount)} || ' ${r.unit}')::interval`;
    return `${col} BETWEEN ${lo} AND ${hi}`;
  }
  return compileScalar(col, p, b);
}

export const sanitize = (s: string) => s.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
