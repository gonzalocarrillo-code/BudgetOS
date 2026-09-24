import "../test-support/env.js";
import { randomUUID } from "node:crypto";
import { openAlert, withTenant, type TenantContext } from "@budget/db";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateWorkspace, metricValue, streak } from "./evaluate.js";
import { runPacing } from "./main.js";

/**
 * T-018 done-when: consecutive-days test; no duplicate open alerts. Budgets and spend are SQL
 * fixtures in their own workspace; the period is the 2026 calendar year (the rule default).
 * Envelope A: budget 1000, spend 700 → pace 1.136 on 2026-08-13 (day 225 of 365), 0.76 on 12-01.
 * Envelope B: budget 1000, spend 500 → pace 0.81 on 08-13 (never over 1.10).
 */

const url = (key: string) => {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set (packages/db/.env)`);
  return v;
};
const owner = new PrismaClient({ datasources: { db: { url: url("DATABASE_URL") } } });
const app = new PrismaClient({ datasources: { db: { url: url("APP_DATABASE_URL") } } });
const orgId = randomUUID();
const ws = randomUUID();
const userId = randomUUID();
const tenant = { workspaceId: ws, orgId };
const env: Record<string, string> = {};
const rules: Record<string, string> = {};

async function envelope(name: string, budget: string, spend: string): Promise<string> {
  const id = randomUUID();
  const v = randomUUID();
  await owner.$executeRawUnsafe(
    `INSERT INTO envelope (id, workspace_id, name, dimension_values, start_date, end_date, currency, status, owner_id, created_by, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, '{}'::jsonb, '2026-01-01', '2026-12-31', 'USD', 'APPROVED', $4::uuid, $4::uuid, now())`,
    id,
    ws,
    name,
    userId,
  );
  await owner.$executeRawUnsafe(
    `INSERT INTO envelope_version (id, envelope_id, version_no, amount, amount_reporting, status, created_by, approved_at) VALUES ($1::uuid, $2::uuid, 1, $3::numeric, $3::numeric, 'APPROVED', $4::uuid, '2026-01-02T00:00:00Z')`,
    v,
    id,
    budget,
    userId,
  );
  await owner.$executeRawUnsafe(`UPDATE envelope SET current_version_id = $2::uuid WHERE id = $1::uuid`, id, v);
  await owner.$executeRawUnsafe(
    `INSERT INTO spend_fact (workspace_id, envelope_id, dimension_values, period_date, currency, amount, amount_reporting, source_system, source_run_id, source_row_hash)
     VALUES ($1::uuid, $2::uuid, '{}'::jsonb, '2026-03-01', 'USD', $3::numeric, $3::numeric, 'fixture', $4::uuid, $5)`,
    ws,
    id,
    spend,
    randomUUID(),
    randomUUID(),
  );
  return id;
}
async function rule(name: string, threshold: string, consecutiveDays: number, severity = "warning"): Promise<string> {
  const id = randomUUID();
  await owner.pacingRule.create({ data: { id, workspaceId: ws, name, metric: "pace_index", comparator: "gt", threshold, consecutiveDays, severity, delivery: { inApp: true, slackChannel: "#pace" } } });
  return id;
}
const openAlerts = (ruleId: string) => owner.alert.findMany({ where: { ruleId, status: { in: ["OPEN", "ACKNOWLEDGED", "SNOOZED"] } } });
const state = (ruleId: string, envelopeId: string) => owner.ruleState.findUnique({ where: { ruleId_envelopeId: { ruleId, envelopeId } } });
const setActive = (keep: string[]) => owner.pacingRule.updateMany({ where: { workspaceId: ws }, data: { isActive: false } }).then(() => owner.pacingRule.updateMany({ where: { id: { in: keep } }, data: { isActive: true } }));

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "t018" } });
  await owner.workspace.create({ data: { id: ws, orgId, slug: `t018-${ws}`, name: "T-018", reportingCurrency: "USD", fiscalYearStartMonth: 1 } });
  await owner.user.create({ data: { id: userId, orgId, email: `${userId}@t018.test`, name: "T-018", googleSub: `g-${userId}` } });
  env["a"] = await envelope("A over pace", "1000.00", "700.00");
  env["b"] = await envelope("B on pace", "1000.00", "500.00");
  rules["overPace"] = await rule("Over-pace", "1.10", 3);
  rules["hot"] = await rule("Hot", "1.00", 1, "critical");
});

afterAll(async () => {
  for (const sql of [
    `DELETE FROM alert WHERE workspace_id = $1::uuid`,
    `DELETE FROM rule_state WHERE rule_id IN (SELECT id FROM pacing_rule WHERE workspace_id = $1::uuid)`,
    `DELETE FROM pacing_rule WHERE workspace_id = $1::uuid`,
    `DELETE FROM spend_fact WHERE workspace_id = $1::uuid`,
    `UPDATE envelope SET current_version_id = NULL WHERE workspace_id = $1::uuid`,
    `DELETE FROM envelope_version WHERE envelope_id IN (SELECT id FROM envelope WHERE workspace_id = $1::uuid)`,
    `DELETE FROM envelope WHERE workspace_id = $1::uuid`,
    `DELETE FROM outbox WHERE workspace_id = $1::uuid`,
  ]) {
    await owner.$executeRawUnsafe(sql, ws);
  }
  await owner.user.deleteMany({ where: { orgId } });
  await owner.workspace.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("streak (consecutive days, ADR-012)", () => {
  const s = (consecutiveDays: number, lastEvalDate: string, priorDays: number) => ({ consecutiveDays, lastEvalDate, priorDays });
  const days = (prev: ReturnType<typeof s> | undefined, today: string, breached: boolean) => streak(prev, today, breached).consecutive;
  it("counts breached days ending today; a same-day re-evaluation replaces today's result", () => {
    expect(days(undefined, "2026-08-13", true)).toBe(1);
    expect(days(s(1, "2026-08-13", 0), "2026-08-14", true)).toBe(2);
    expect(days(s(2, "2026-08-14", 1), "2026-08-14", true)).toBe(2); // every 15 minutes, same day
    expect(days(s(2, "2026-08-14", 1), "2026-08-14", false)).toBe(0);
    // Unbreached at 08:00, breached at 08:15: yesterday's streak of 2 is still there.
    expect(days(s(0, "2026-08-15", 2), "2026-08-15", true)).toBe(3);
    expect(days(s(3, "2026-08-14", 2), "2026-08-16", true)).toBe(1); // a missed day restarts
    expect(days(s(0, "2026-08-13", 0), "2026-08-14", true)).toBe(1);
  });

  it("reads pace from the planner row and leaves projection metrics null without a projection", () => {
    expect(metricValue({ metric: "pace_index" }, {}, { pace_index: "1.2" })?.toString()).toBe("1.2");
    expect(metricValue({ metric: "projected_close_pct" }, {}, { projected: "0", projected_close_pct: "0" })).toBeNull();
    expect(metricValue({ metric: "kpi_vs_target_pct" }, { metricKey: "cpa" }, { vs_cpa: "1.3" })?.toString()).toBe("1.3");
    const gap = metricValue({ metric: "implied_volume_gap" }, {}, { budget: "1000", projected: "900", kpi_cpa: "12", tgt_cpa: "10" });
    expect(gap?.toDecimalPlaces(4).toString()).toBe(new Decimal(900).div(12).minus(100).div(100).toDecimalPlaces(4).toString()); // 75 vs 100 implied → -0.25
  });
});

describe("evaluateWorkspace (T-018 done-when)", () => {
  it("opens the 3-day alert on the third consecutive breached day, not before, and once", async () => {
    await setActive([rules["overPace"] as string]);
    await evaluateWorkspace(app, tenant, "2026-08-13");
    await evaluateWorkspace(app, tenant, "2026-08-13"); // same day again (15-minute schedule)
    expect(await state(rules["overPace"] as string, env["a"] as string)).toMatchObject({ consecutiveDays: 1, priorDays: 0 });
    expect(await state(rules["overPace"] as string, env["b"] as string)).toMatchObject({ consecutiveDays: 0, priorDays: 0 });
    const day14 = await evaluateWorkspace(app, tenant, "2026-08-14");
    expect(day14.opened).toEqual([]);
    expect(await openAlerts(rules["overPace"] as string)).toHaveLength(0);

    const day15 = await evaluateWorkspace(app, tenant, "2026-08-15");
    expect(day15.opened).toHaveLength(1);
    const [alert] = await openAlerts(rules["overPace"] as string);
    expect(alert).toMatchObject({ envelopeId: env["a"], severity: "warning", status: "OPEN", ownerId: userId });
    expect(new Decimal(alert?.metricValue.toString() ?? 0).gt("1.10")).toBe(true);
    expect(alert?.context).toMatchObject({ budget: "1000.00", actual: "700.00", evaluatedFor: "2026-08-15" });
    expect(await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM audit_event WHERE entity_id = $1::uuid AND action = 'alert.opened'`, alert?.id).then((r) => Number(r[0]?.n))).toBe(1);
    expect(await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE topic = 'alert.triggered' AND payload->>'alertId' = $1`, alert?.id).then((r) => Number(r[0]?.n))).toBe(1);

    // Still breached on the following days and re-runs: never a second open alert.
    await evaluateWorkspace(app, tenant, "2026-08-15");
    await evaluateWorkspace(app, tenant, "2026-08-16");
    await Promise.all([evaluateWorkspace(app, tenant, "2026-08-17"), evaluateWorkspace(app, tenant, "2026-08-17")]);
    expect(await openAlerts(rules["overPace"] as string)).toHaveLength(1);
    expect(await state(rules["overPace"] as string, env["a"] as string)).toMatchObject({ consecutiveDays: 5 });
  });

  it("a missed day restarts the count", async () => {
    await evaluateWorkspace(app, tenant, "2026-08-19"); // 08-18 skipped
    expect(await state(rules["overPace"] as string, env["a"] as string)).toMatchObject({ consecutiveDays: 1 });
  });

  it("resolves when the metric recovers, and a later breach opens a new alert", async () => {
    const r = await evaluateWorkspace(app, tenant, "2026-12-01"); // pace 0.76
    expect(r.resolved).toHaveLength(1);
    expect(await openAlerts(rules["overPace"] as string)).toHaveLength(0);
    expect(await owner.alert.count({ where: { ruleId: rules["overPace"] ?? "", status: "RESOLVED" } })).toBe(1);
    expect(await state(rules["overPace"] as string, env["a"] as string)).toMatchObject({ consecutiveDays: 0, priorDays: 0 });
  });

  it("the database refuses a second open alert for the same rule and envelope, even when two inserts race", async () => {
    const insert = () =>
      withTenant(app, { workspaceId: ws, orgId, userId: null, isOrgAdmin: false, actorType: "system", requestId: `t018-${randomUUID()}` } satisfies TenantContext, (tx) =>
        openAlert(tx, { id: randomUUID(), workspaceId: ws, ruleId: rules["overPace"] as string, envelopeId: env["b"] as string, severity: "warning", metricValue: "1.2", threshold: "1.1", context: {}, ownerId: null }),
      );
    const results = await Promise.all([insert(), insert(), insert()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await openAlerts(rules["overPace"] as string)).filter((a) => a.envelopeId === env["b"])).toHaveLength(1);
    await owner.alert.deleteMany({ where: { ruleId: rules["overPace"] ?? "", envelopeId: env["b"] ?? "" } });
  });

  it("a snoozed alert stays quiet until snoozedUntil, then reopens if still breached", async () => {
    await setActive([rules["hot"] as string]);
    await evaluateWorkspace(app, tenant, "2026-08-13");
    const [alert] = await openAlerts(rules["hot"] as string);
    expect(alert?.envelopeId).toBe(env["a"]);
    await owner.alert.update({ where: { id: alert?.id ?? "" }, data: { status: "SNOOZED", snoozedUntil: new Date("2026-08-20T00:00:00Z") } });
    const quiet = await evaluateWorkspace(app, tenant, "2026-08-14", new Date("2026-08-14T12:00:00Z"));
    expect(quiet.reopened).toEqual([]);
    expect(quiet.resolved).toEqual([]);
    const awake = await evaluateWorkspace(app, tenant, "2026-08-21", new Date("2026-08-21T12:00:00Z"));
    expect(awake.reopened).toEqual([alert?.id]);
    expect(await owner.alert.findUniqueOrThrow({ where: { id: alert?.id ?? "" } })).toMatchObject({ status: "OPEN", snoozedUntil: null });
    expect(await openAlerts(rules["hot"] as string)).toHaveLength(1);
  });

  it("runPacing evaluates every workspace of the orgs it is given", async () => {
    const out = await runPacing(app, [orgId], "2026-08-22");
    expect(out.map((o) => o.workspaceId)).toEqual([ws]);
  });
});
