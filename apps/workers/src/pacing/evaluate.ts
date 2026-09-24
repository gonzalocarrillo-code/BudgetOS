import { FilterGroup, QueryRequest, RuleMetricArgs, newId, resolvePeriod, type FilterGroupT, type Predicate } from "@budget/domain";
import { audit, openAlert, outbox, plannerOptions, saveRuleStates, withTenant, type RuleStateInput, type TenantContext, type Tx } from "@budget/db";
import { compileQuery, pageOf } from "@budget/query-planner";
import { Decimal } from "decimal.js";
import type { PacingRule, PrismaClient } from "@prisma/client";
import { log } from "../log.js";

/**
 * Pacing evaluator (spec §11, ADR-012). For each active rule: envelopes in scope with their metric
 * through the planner (one query per rule), then per envelope the consecutive-day streak and the
 * alert lifecycle. At most one open alert per rule and envelope (partial unique index). Every alert
 * transition writes one audit_event and one outbox row; rule_state is bookkeeping and is not audited.
 */

type Row = Record<string, unknown>;
const OPEN = ["OPEN", "ACKNOWLEDGED", "SNOOZED"] as const;
const MEASURES = ["budget", "actual", "projected", "pace_index", "projected_close_pct", "spend_to_date_pct", "variance_abs"] as const;

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dec = (v: unknown): Decimal | null => (v === null || v === undefined ? null : new Decimal(String(v)));

/** The KPI a rule reads, so the planner adds its kpi_/tgt_/vs_ columns. */
function targetsFor(rule: PacingRule, args: RuleMetricArgs): string[] {
  if (rule.metric === "kpi_vs_target_pct") return args.metricKey ? [args.metricKey] : [];
  if (rule.metric === "implied_volume_gap" || rule.metric === "efficiency_adjusted_pace") return ["cpa"];
  return [];
}

/**
 * The rule's metric for one planner row, or null when it cannot be computed (no budget, no target,
 * no conversions). An envelope without projection facts has projected = 0; projection-based
 * metrics are null for it rather than a false "0% projected close".
 */
export function metricValue(rule: Pick<PacingRule, "metric">, args: RuleMetricArgs, row: Row): Decimal | null {
  const projected = dec(row["projected"]);
  const hasProjection = projected !== null && !projected.isZero();
  const cpa = () => ({ actual: dec(row["kpi_cpa"]), target: dec(row["tgt_cpa"]) });
  switch (rule.metric) {
    case "pace_index":
      return dec(row["pace_index"]);
    case "spend_to_date_pct":
      return dec(row["spend_to_date_pct"]);
    case "projected_close_pct":
      return hasProjection ? dec(row["projected_close_pct"]) : null;
    case "projected_variance_abs":
      return hasProjection ? dec(row["variance_abs"]) : null;
    case "kpi_vs_target_pct":
      return args.metricKey ? dec(row[`vs_${args.metricKey}`]) : null;
    case "implied_volume_gap": {
      const { actual, target } = cpa();
      const budget = dec(row["budget"]);
      if (!hasProjection || !budget || !actual || !target || actual.isZero() || target.isZero() || budget.isZero()) return null;
      const implied = budget.div(target);
      return (projected as Decimal).div(actual).minus(implied).div(implied);
    }
    case "efficiency_adjusted_pace": {
      const { actual, target } = cpa();
      const pace = dec(row["pace_index"]);
      if (!pace || !actual || !target || target.isZero()) return null;
      return pace.mul(actual.div(target));
    }
    default:
      return null;
  }
}

export function breaches(comparator: string, value: Decimal, threshold: Decimal): boolean {
  switch (comparator) {
    case "gt":
      return value.gt(threshold);
    case "gte":
      return value.gte(threshold);
    case "lt":
      return value.lt(threshold);
    case "lte":
      return value.lte(threshold);
    default:
      throw new Error(`unknown comparator ${comparator}`);
  }
}

/**
 * Consecutive breached days ending `today` (ADR-012). `priorDays` is the streak through the day
 * before `lastEvalDate`, so a same-day re-evaluation recomputes today on top of it: every 15 minutes
 * the count neither grows nor forgets yesterday. A missed or unbreached day restarts the count.
 */
export function streak(prev: { consecutiveDays: number; lastEvalDate: string; priorDays: number } | undefined, today: string, breached: boolean): { consecutive: number; priorDays: number } {
  const priorDays = !prev ? 0 : prev.lastEvalDate === today ? prev.priorDays : prev.lastEvalDate === addDays(today, -1) ? prev.consecutiveDays : 0;
  return { consecutive: breached ? priorDays + 1 : 0, priorDays };
}

export interface EvaluateResult {
  rules: number;
  evaluated: number;
  opened: string[];
  reopened: string[];
  resolved: string[];
}

/** Rules that read the same envelopes (period, scope, days-remaining window) share one planner query. */
function queryKey(rule: PacingRule, args: RuleMetricArgs): string {
  return JSON.stringify({ period: args.period ?? null, scope: rule.scope ?? {}, days: args.daysRemainingLt ?? null });
}

async function rowsFor(tx: Tx, tenant: { workspaceId: string; orgId: string }, rule: PacingRule, args: RuleMetricArgs, targets: string[], today: string, fiscalStart: number): Promise<Row[]> {
  const period = resolvePeriod(args.period ?? { kind: "relative", preset: "current_year" }, today, fiscalStart);
  const scope = FilterGroup.safeParse(rule.scope);
  const children: Array<Predicate | FilterGroupT> = [{ field: { kind: "attr", key: "status" }, op: "neq", value: "ARCHIVED" }];
  if (scope.success && scope.data.children.length > 0) children.push(scope.data);
  if (args.daysRemainingLt !== undefined) {
    children.push({ field: { kind: "attr", key: "end_date" }, op: "gte", value: today });
    children.push({ field: { kind: "attr", key: "end_date" }, op: "lt", value: addDays(today, args.daysRemainingLt) });
  }
  const opts = await plannerOptions(tx, tenant, targets, period);
  const out: Row[] = [];
  let cursor: string | null = null;
  do {
    const q = QueryRequest.parse({ workspaceId: tenant.workspaceId, filter: { logic: "and", children }, measures: [...MEASURES], targets, period: { kind: "range", ...period }, limit: 1000, ...(cursor ? { cursor } : {}) });
    const c = compileQuery(q, period, today, opts);
    const page = pageOf(c, await tx.$queryRawUnsafe<Row[]>(c.sql, ...c.values), q.limit);
    out.push(...page.rows);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

export async function evaluateWorkspace(prisma: PrismaClient, tenant: { workspaceId: string; orgId: string }, today: string, now: Date = new Date()): Promise<EvaluateResult> {
  const ctx: TenantContext = { workspaceId: tenant.workspaceId, orgId: tenant.orgId, userId: null, isOrgAdmin: false, actorType: "system", requestId: `pacing-${today}-${tenant.workspaceId}` };
  const result: EvaluateResult = { rules: 0, evaluated: 0, opened: [], reopened: [], resolved: [] };
  await withTenant(
    prisma,
    ctx,
    async (tx) => {
      const ws = await tx.workspace.findUniqueOrThrow({ where: { id: tenant.workspaceId }, select: { fiscalYearStartMonth: true } });
      const rules = await tx.pacingRule.findMany({ where: { workspaceId: tenant.workspaceId, isActive: true }, orderBy: { id: "asc" } });
      result.rules = rules.length;
      const parsed: Array<{ rule: PacingRule; args: RuleMetricArgs }> = [];
      for (const rule of rules) {
        const args = RuleMetricArgs.safeParse(rule.metricArgs);
        if (args.success) parsed.push({ rule, args: args.data });
        else log.error({ ruleId: rule.id, workspaceId: tenant.workspaceId, requestId: ctx.requestId, issues: args.error.flatten() }, "pacing rule has unreadable metricArgs; skipped");
      }
      const groupTargets = new Map<string, Set<string>>();
      for (const { rule, args } of parsed) {
        const key = queryKey(rule, args);
        const set = groupTargets.get(key) ?? new Set<string>();
        for (const t of targetsFor(rule, args)) set.add(t);
        groupTargets.set(key, set);
      }
      const rowsByKey = new Map<string, Row[]>();
      for (const { rule, args: ruleArgs } of parsed) {
        const key = queryKey(rule, ruleArgs);
        let rows = rowsByKey.get(key);
        if (rows === undefined) {
          rows = await rowsFor(tx, tenant, rule, ruleArgs, [...(groupTargets.get(key) ?? [])].sort(), today, ws.fiscalYearStartMonth);
          rowsByKey.set(key, rows);
        }
        const envelopeIds = rows.map((r) => String(r["envelope_id"]));
        const states = new Map(
          (await tx.ruleState.findMany({ where: { ruleId: rule.id, envelopeId: { in: envelopeIds } } })).map((s) => [
            s.envelopeId,
            { consecutiveDays: s.consecutiveDays, lastEvalDate: s.lastEvalDate.toISOString().slice(0, 10), priorDays: s.priorDays },
          ]),
        );
        const open = new Map(
          (await tx.alert.findMany({ where: { ruleId: rule.id, envelopeId: { in: envelopeIds }, status: { in: [...OPEN] } } })).map((a) => [a.envelopeId, a]),
        );
        const threshold = new Decimal(rule.threshold.toString());
        const saved: RuleStateInput[] = [];
        const toOpen: Array<{ envelopeId: string; value: Decimal; row: Row }> = [];
        for (const row of rows) {
          const envelopeId = String(row["envelope_id"]);
          const value = metricValue(rule, ruleArgs, row);
          if (value === null) continue;
          result.evaluated += 1;
          const breached = breaches(rule.comparator, value, threshold);
          const { consecutive, priorDays } = streak(states.get(envelopeId), today, breached);
          saved.push({ envelopeId, consecutiveDays: consecutive, lastEvalDate: today, lastValue: value.toDecimalPlaces(4).toFixed(4), priorDays });
          const existing = open.get(envelopeId);
          if (breached && consecutive >= rule.consecutiveDays && !existing) {
            toOpen.push({ envelopeId, value, row });
          } else if (breached && existing?.status === "SNOOZED" && existing.snoozedUntil !== null && existing.snoozedUntil <= now) {
            await tx.alert.update({ where: { id: existing.id }, data: { status: "OPEN", snoozedUntil: null, metricValue: value.toDecimalPlaces(4).toFixed(4) } });
            await audit(tx, { workspaceId: tenant.workspaceId, actorId: null, actorType: "system", action: "alert.reopened", entityType: "alert", entityId: existing.id, after: { rule: rule.name, value: value.toFixed(4) }, requestId: ctx.requestId });
            await outbox(tx, { workspaceId: tenant.workspaceId, topic: "alert.triggered", payload: { alertId: existing.id, ruleId: rule.id, envelopeId, severity: rule.severity, delivery: rule.delivery, reopened: true } });
            result.reopened.push(existing.id);
          } else if (!breached && existing && existing.status !== "SNOOZED") {
            await tx.alert.update({ where: { id: existing.id }, data: { status: "RESOLVED", resolvedAt: now } });
            await audit(tx, { workspaceId: tenant.workspaceId, actorId: null, actorType: "system", action: "alert.resolved", entityType: "alert", entityId: existing.id, after: { rule: rule.name, value: value.toFixed(4) }, requestId: ctx.requestId });
            await outbox(tx, { workspaceId: tenant.workspaceId, topic: "alert.changed", payload: { alertId: existing.id, status: "RESOLVED" } });
            result.resolved.push(existing.id);
          }
        }
        await saveRuleStates(tx, rule.id, saved);

        const owners = new Map((await tx.envelope.findMany({ where: { id: { in: toOpen.map((o) => o.envelopeId) } }, select: { id: true, ownerId: true } })).map((e) => [e.id, e.ownerId]));
        const metricKey = targetsFor(rule, ruleArgs)[0];
        for (const { envelopeId, value, row } of toOpen) {
          const id = newId();
          const money = (v: unknown) => dec(v)?.toFixed(2) ?? null;
          const ratio = (v: unknown) => dec(v)?.toDecimalPlaces(4).toString() ?? null;
          const context = {
            budget: money(row["budget"]),
            actual: money(row["actual"] ?? 0),
            projected: money(row["projected"] ?? 0),
            ...(metricKey ? { target: ratio(row[`tgt_${metricKey}`]), kpi: ratio(row[`kpi_${metricKey}`]), metricKey } : {}),
            dataAsOf: now.toISOString(),
            evaluatedFor: today,
          };
          const inserted = await openAlert(tx, { id, workspaceId: tenant.workspaceId, ruleId: rule.id, envelopeId, severity: rule.severity, metricValue: value.toDecimalPlaces(4).toFixed(4), threshold: threshold.toFixed(4), context, ownerId: owners.get(envelopeId) ?? null });
          if (!inserted) continue; // another evaluator opened it first
          await audit(tx, { workspaceId: tenant.workspaceId, actorId: null, actorType: "system", action: "alert.opened", entityType: "alert", entityId: id, after: { rule: rule.name, envelopeId, value: value.toFixed(4) }, requestId: ctx.requestId });
          await outbox(tx, { workspaceId: tenant.workspaceId, topic: "alert.triggered", payload: { alertId: id, ruleId: rule.id, envelopeId, severity: rule.severity, delivery: rule.delivery } });
          result.opened.push(id);
        }
      }
      await tx.$executeRaw`SELECT ensure_fact_partitions(date_trunc('month', ${today}::date)::date, 3)`;
    },
    { timeoutMs: 300_000 },
  );
  log.info({ workspaceId: tenant.workspaceId, requestId: ctx.requestId, today, ...{ rules: result.rules, evaluated: result.evaluated, opened: result.opened.length, reopened: result.reopened.length, resolved: result.resolved.length } }, "pacing evaluated");
  return result;
}
