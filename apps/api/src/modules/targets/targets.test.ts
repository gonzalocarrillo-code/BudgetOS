import { randomUUID } from "node:crypto";
import { QueryRequest } from "@budget/domain";
import { withTenant } from "@budget/db";
import { compileQuery } from "@budget/query-planner";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appDb, ownerDb, startHarness, testUser, type Harness, type TestUser } from "../../test-support/harness.js";
import { plannerOptions } from "./queries/planner-options.js";

/**
 * T-015 (spec §10): targets module, metric library, effective_target. Targets are versioned like
 * budgets (new version per change, stale draft = 409), go through approval policies with
 * entityType target_version, inherit down the envelope tree, and filter-scoped targets fill in
 * where no envelope target exists. The roll-up done-when is in @budget/query-planner
 * (targets.rollup.test.ts); the last test here runs the planner with this module's options.
 */

const owner = ownerDb();
const app = appDb();
let h: Harness;

const orgId = randomUUID();
const ws = randomUUID();
const planner = testUser("t015-planner", randomUUID());
const approver = testUser("t015-approver", randomUUID());
const scopedOwner = testUser("t015-scoped", randomUUID());
const viewer = testUser("t015-viewer", randomUUID());
const orgAdmin = testUser("t015-org-admin", randomUUID());
const region = randomUUID();
const platform = randomUUID();
const X = { "x-workspace-id": ws };
let seq = 0;
const rid = () => `t015-${++seq}-${orgId}`;
const env: Record<string, string> = {};

type Res = { status: number; body: Record<string, unknown> };
async function call(user: TestUser, method: "GET" | "POST" | "PATCH", url: string, body?: unknown, requestId = rid()): Promise<Res> {
  return h.call(method, `/api/v1${url}`, await h.mint(user), { headers: { ...X, "x-request-id": requestId }, ...(body === undefined ? {} : { body }) });
}
const createTarget = (user: TestUser, body: Record<string, unknown>, requestId?: string) => call(user, "POST", `/workspaces/${ws}/targets`, body, requestId);
const submit = (user: TestUser, targetId: string, versionId: string) => call(user, "POST", `/targets/${targetId}/submit`, { versionId });

async function auditActions(requestId: string): Promise<string[]> {
  const rows = await owner.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_event WHERE request_id = $1 ORDER BY occurred_at`, requestId);
  return rows.map((r) => r.action);
}
async function outboxCount(topic: string, targetId: string): Promise<number> {
  const rows = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE workspace_id = $1::uuid AND topic = $2 AND payload->>'targetId' = $3`, ws, topic, targetId);
  return Number(rows[0]?.n ?? 0);
}

async function approvedEnvelope(name: string, dimensionValues: Record<string, string>, amount: string, parentId: string | null = null): Promise<string> {
  const created = await call(planner, "POST", `/workspaces/${ws}/envelopes`, { name, parentId, dimensionValues, startDate: "2026-10-01", endDate: "2026-12-31", currency: "USD", amount });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = String(created.body["id"]);
  const s = await call(planner, "POST", `/envelopes/${id}/submit`, { versionId: created.body["draftVersionId"] });
  expect(s.body["autoApproved"], JSON.stringify(s.body)).toBe(true);
  return id;
}

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "t015" } });
  await owner.workspace.create({ data: { id: ws, orgId, slug: `t015-${ws}`, name: "T-015", reportingCurrency: "USD" } });
  await owner.user.createMany({ data: [planner, approver, scopedOwner, viewer, orgAdmin].map((u) => ({ id: u.id, orgId, email: u.email, name: u.email, googleSub: `g-${u.sub}` })) });
  const latam = { logic: "and", children: [{ field: { kind: "dimension", key: "region" }, op: "descends_from", value: "latam" }] };
  await owner.roleAssignment.createMany({
    data: [
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: planner.id, role: "PLANNER", createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: approver.id, role: "APPROVER", createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: scopedOwner.id, role: "BUDGET_OWNER", scope: latam, createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: viewer.id, role: "VIEWER", createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: null, principalType: "user", principalId: orgAdmin.id, role: "ORG_ADMIN", createdBy: orgAdmin.id },
    ],
  });
  await owner.$executeRawUnsafe(
    `INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by) VALUES ($1::uuid, $3::uuid, NULL, 'region', 'Region', 'ENUM', $4::uuid), ($2::uuid, $3::uuid, NULL, 'platform', 'Platform', 'ENUM', $4::uuid)`,
    region,
    platform,
    orgId,
    orgAdmin.id,
  );
  const ids: Record<string, string> = {};
  for (const [code, dim, parent] of [["latam", region, null], ["br", region, "latam"], ["mx", region, "latam"], ["emea", region, null], ["de", region, "emea"], ["meta", platform, null]] as const) {
    ids[code] = randomUUID();
    await owner.$executeRawUnsafe(`INSERT INTO dimension_value (id, dimension_id, code, label, parent_value_id) VALUES ($1::uuid, $2::uuid, $3, $3, $4::uuid)`, ids[code], dim, code, parent ? ids[parent] : null);
  }
  // Envelopes auto-approve; a target change under 10% auto-approves, any other needs an APPROVER.
  await owner.approvalPolicy.createMany({
    data: [
      { id: randomUUID(), workspaceId: ws, name: "Envelopes auto", priority: 1, conditions: { entityType: "envelope_version" }, chain: [], blockSelfApproval: true },
      { id: randomUUID(), workspaceId: ws, name: "Target tweak", priority: 2, conditions: { entityType: "target_version", deltaPct: { lt: 0.1 } }, chain: [], blockSelfApproval: true },
      { id: randomUUID(), workspaceId: ws, name: "Target change", priority: 3, conditions: { entityType: "target_version" }, chain: [{ role: "APPROVER", minApprovals: 1, timeoutHours: 48 }], blockSelfApproval: true },
    ],
  });
  h = await startHarness();
  env["latam"] = await approvedEnvelope("LATAM", { region: "latam" }, "10000.00");
  env["br"] = await approvedEnvelope("BR Meta", { region: "br", platform: "meta" }, "3600.00", env["latam"]);
  env["mx"] = await approvedEnvelope("MX Meta", { region: "mx", platform: "meta" }, "2000.00", env["latam"]);
  env["de"] = await approvedEnvelope("DE Meta", { region: "de", platform: "meta" }, "900.00");
}, 60_000);

afterAll(async () => {
  await h?.close();
  const envs = `(SELECT id FROM envelope WHERE workspace_id = $1::uuid)`;
  for (const sql of [
    `DELETE FROM comment WHERE thread_id IN (SELECT id FROM thread WHERE workspace_id = $1::uuid)`,
    `DELETE FROM thread WHERE workspace_id = $1::uuid`,
    `DELETE FROM approval_decision WHERE request_id IN (SELECT id FROM approval_request WHERE workspace_id = $1::uuid)`,
    `DELETE FROM approval_request WHERE workspace_id = $1::uuid`,
    `UPDATE target SET current_version_id = NULL, draft_version_id = NULL WHERE workspace_id = $1::uuid`,
    `DELETE FROM target_version WHERE target_id IN (SELECT id FROM target WHERE workspace_id = $1::uuid)`,
    `DELETE FROM target WHERE workspace_id = $1::uuid`,
    `DELETE FROM approval_policy WHERE workspace_id = $1::uuid`,
    `UPDATE envelope SET current_version_id = NULL, draft_version_id = NULL, parent_id = NULL WHERE workspace_id = $1::uuid`,
    `DELETE FROM envelope_phasing WHERE version_id IN (SELECT id FROM envelope_version WHERE envelope_id IN ${envs})`,
    `DELETE FROM envelope_version WHERE envelope_id IN ${envs}`,
    `DELETE FROM envelope_dimension WHERE envelope_id IN ${envs}`,
    `DELETE FROM envelope WHERE workspace_id = $1::uuid`,
    `DELETE FROM outbox WHERE workspace_id = $1::uuid`,
  ]) {
    await owner.$executeRawUnsafe(sql, ws);
  }
  await owner.$executeRawUnsafe(`DELETE FROM metric_definition WHERE org_id = $1::uuid`, orgId);
  await owner.$executeRawUnsafe(`DELETE FROM dimension_value WHERE dimension_id IN ($1::uuid, $2::uuid)`, region, platform);
  await owner.$executeRawUnsafe(`DELETE FROM dimension WHERE org_id = $1::uuid`, orgId);
  await owner.roleAssignment.deleteMany({ where: { principalId: { in: [planner.id, approver.id, scopedOwner.id, viewer.id, orgAdmin.id] } } });
  await owner.user.deleteMany({ where: { orgId } });
  await owner.workspace.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("metric library (GET/POST /workspaces/:ws/metrics)", () => {
  it("only an org admin adds a metric; keys are unique per org; members can read the library", async () => {
    const cpa = { key: "cpa", label: "CPA", numerator: "spend", denominator: "kpi:conversions", direction: "lower_is_better", format: "currency" };
    expect((await call(planner, "POST", `/workspaces/${ws}/metrics`, cpa)).status).toBe(403);
    const requestId = rid();
    const created = await call(orgAdmin, "POST", `/workspaces/${ws}/metrics`, cpa, requestId);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ key: "cpa", numerator: "spend", denominator: "kpi:conversions", multiplier: "1" });
    expect(await auditActions(requestId)).toEqual(["metric.created"]);
    expect((await call(orgAdmin, "POST", `/workspaces/${ws}/metrics`, cpa)).status).toBe(409);
    expect((await call(orgAdmin, "POST", `/workspaces/${ws}/metrics`, { ...cpa, key: "bad", numerator: "clicks" })).status).toBe(422);
    const cpm = await call(orgAdmin, "POST", `/workspaces/${ws}/metrics`, { key: "cpm", label: "CPM", numerator: "spend", denominator: "kpi:impressions", multiplier: "1000", direction: "lower_is_better", format: "currency" });
    expect(cpm.body["multiplier"]).toBe("1000");
    const list = (await call(viewer, "GET", `/workspaces/${ws}/metrics`)).body as unknown as Array<{ key: string }>;
    expect(list.map((m) => m.key)).toEqual(["cpa", "cpm"]);
  });
});

describe("targets: versions, approval, concurrency", () => {
  let parentTarget: string;

  it("creates a target with a v1 draft: one audit_event + one target.changed outbox row", async () => {
    const requestId = rid();
    const res = await createTarget(planner, { scope: { type: "envelope", envelopeId: env["latam"] }, metricKey: "cpa", value: "20.00", comparator: "lte", rationale: "FY27 plan" }, requestId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    parentTarget = String(res.body["id"]);
    expect(res.body).toMatchObject({ scopeType: "envelope", envelopeId: env["latam"], metricKey: "cpa", startDate: "2026-10-01", endDate: "2026-12-31", currentVersionId: null });
    expect(res.body["draft"]).toMatchObject({ versionNo: 1, value: "20", comparator: "lte", currency: "USD", status: "DRAFT" });
    expect(await auditActions(requestId)).toEqual(["target.created"]);
    expect(await outboxCount("target.changed", parentTarget)).toBe(1);
  });

  it("refuses a second envelope target for the same metric, an unknown metric, and a viewer", async () => {
    expect((await createTarget(planner, { scope: { type: "envelope", envelopeId: env["latam"] }, metricKey: "cpa", value: "1" })).status).toBe(409);
    expect((await createTarget(planner, { scope: { type: "envelope", envelopeId: env["latam"] }, metricKey: "roas", value: "1" })).status).toBe(422);
    expect((await createTarget(viewer, { scope: { type: "envelope", envelopeId: env["mx"] }, metricKey: "cpa", value: "1" })).status).toBe(403);
    expect((await createTarget(planner, { scope: { type: "envelope", envelopeId: env["mx"] }, metricKey: "cpa", value: "1", comparator: "between" })).status).toBe(422);
  });

  it("a first target needs an APPROVER (deltaPct 100%); the approver's decision makes it current", async () => {
    const t = (await call(planner, "GET", `/targets/${parentTarget}/versions`)).body as { versions: Array<{ id: string }> };
    const v1 = t.versions[0]?.id as string;
    const s = await submit(planner, parentTarget, v1);
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    expect(s.body).toMatchObject({ autoApproved: false, policy: { name: "Target change" } });
    const requestId = String(s.body["requestId"]);
    const inbox = (await call(approver, "GET", `/approvals?assignee=me`)).body as { rows: Array<{ id: string; entityType: string; targetId: string | null }> };
    expect(inbox.rows.find((r) => r.id === requestId)).toMatchObject({ entityType: "target_version", targetId: parentTarget });
    const detail = (await call(approver, "GET", `/approvals/${requestId}`)).body;
    expect(detail["target"]).toMatchObject({ metricKey: "cpa", value: "20", approvedValue: null });
    expect((await call(planner, "POST", `/approvals/${requestId}/decisions`, { decision: "approve" })).status).toBe(403); // not an APPROVER, and the author
    const d = await call(approver, "POST", `/approvals/${requestId}/decisions`, { decision: "approve" });
    expect(d.body, JSON.stringify(d.body)).toMatchObject({ status: "APPROVED" });
    const target = await owner.target.findUniqueOrThrow({ where: { id: parentTarget } });
    expect(target.currentVersionId).toBe(v1);
    expect(target.draftVersionId).toBeNull();
    expect((await owner.targetVersion.findUniqueOrThrow({ where: { id: v1 } })).status).toBe("APPROVED");
  });

  it("a stale basedOnVersionId is 409 with currentVersionId; a small change auto-approves as a new version", async () => {
    const current = (await owner.target.findUniqueOrThrow({ where: { id: parentTarget } })).currentVersionId as string;
    const stale = await call(planner, "PATCH", `/targets/${parentTarget}/draft`, { basedOnVersionId: null, value: "21" });
    expect(stale.status).toBe(409);
    expect((stale.body["details"] as { currentVersionId: string }).currentVersionId).toBe(current);

    const requestId = rid();
    const v2 = await call(planner, "PATCH", `/targets/${parentTarget}/draft`, { basedOnVersionId: current, value: "21.00", rationale: "efficiency" }, requestId);
    expect(v2.status, JSON.stringify(v2.body)).toBe(200);
    expect(v2.body).toMatchObject({ versionNo: 2, value: "21", status: "DRAFT" });
    expect(await auditActions(requestId)).toEqual(["target.version.created"]);
    const s = await submit(planner, parentTarget, String(v2.body["id"]));
    expect(s.body).toMatchObject({ autoApproved: true, policy: { name: "Target tweak" } });
    const versions = ((await call(viewer, "GET", `/targets/${parentTarget}/versions`)).body as { versions: Array<{ versionNo: number; status: string; value: string }> }).versions;
    expect(versions.map((v) => [v.versionNo, v.status, v.value])).toEqual([
      [2, "APPROVED", "21"],
      [1, "SUPERSEDED", "20"],
    ]);
  });

  it("a rejected change leaves the current version in place and closes the draft (never deleted)", async () => {
    const current = (await owner.target.findUniqueOrThrow({ where: { id: parentTarget } })).currentVersionId as string;
    const v3 = await call(planner, "PATCH", `/targets/${parentTarget}/draft`, { basedOnVersionId: current, value: "35" });
    const s = await submit(planner, parentTarget, String(v3.body["id"]));
    expect(s.body["autoApproved"]).toBe(false);
    expect((await call(planner, "PATCH", `/targets/${parentTarget}/draft`, { basedOnVersionId: String(v3.body["id"]), value: "36" })).status).toBe(409); // pending
    const d = await call(approver, "POST", `/approvals/${String(s.body["requestId"])}/decisions`, { decision: "reject", comment: "too loose" });
    expect(d.body["status"]).toBe("REJECTED");
    const t = await owner.target.findUniqueOrThrow({ where: { id: parentTarget } });
    expect(t.currentVersionId).toBe(current);
    expect(t.draftVersionId).toBeNull();
    expect((await owner.targetVersion.findUniqueOrThrow({ where: { id: String(v3.body["id"]) } })).status).toBe("REJECTED");
  });
});

describe("effective targets: inheritance, override, filter scope, implied volume", () => {
  it("scope: a LATAM-scoped owner sets targets under LATAM only, and never filter targets", async () => {
    expect((await createTarget(scopedOwner, { scope: { type: "envelope", envelopeId: env["de"] }, metricKey: "cpa", value: "30" })).status).toBe(403);
    const filter = { type: "filter", filter: { logic: "and", children: [{ field: { kind: "dimension", key: "region" }, op: "eq", value: "br" }] } };
    expect((await createTarget(scopedOwner, { scope: filter, metricKey: "cpa", value: "30", startDate: "2026-10-01", endDate: "2026-12-31" })).status).toBe(403);
    const mx = await createTarget(scopedOwner, { scope: { type: "envelope", envelopeId: env["mx"] }, metricKey: "cpa", value: "15" });
    expect(mx.status, JSON.stringify(mx.body)).toBe(201);
    const s = await submit(scopedOwner, String(mx.body["id"]), String((mx.body["draft"] as { id: string }).id));
    const d = await call(approver, "POST", `/approvals/${String(s.body["requestId"])}/decisions`, { decision: "approve" });
    expect(d.body["status"]).toBe("APPROVED");
  });

  it("a filter-scoped target is created by a workspace-wide role and approved like any other", async () => {
    const filter = { type: "filter", filter: { logic: "and", children: [{ field: { kind: "dimension", key: "region" }, op: "descends_from", value: "emea" }] } };
    expect((await createTarget(planner, { scope: filter, metricKey: "cpa", value: "30" })).status).toBe(422); // dates required
    const t = await createTarget(planner, { scope: filter, metricKey: "cpa", value: "30", startDate: "2026-10-01", endDate: "2026-12-31" });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const s = await submit(planner, String(t.body["id"]), String((t.body["draft"] as { id: string }).id));
    const d = await call(approver, "POST", `/approvals/${String(s.body["requestId"])}/decisions`, { decision: "approve" });
    expect(d.body["status"]).toBe("APPROVED");
    const list = (await call(viewer, "GET", `/workspaces/${ws}/targets?scopeType=filter`)).body as unknown as Array<{ id: string; current: { value: string } | null }>;
    expect(list.map((x) => [x.id, x.current?.value])).toEqual([[t.body["id"], "30"]]);
  });

  it("GET /envelopes/:id/targets: own, inherited or filter target, with implied volume = budget / CPA target", async () => {
    const get = async (key: string) => (await call(viewer, "GET", `/envelopes/${env[key]}/targets`)).body as { budget: string; targets: Array<Record<string, unknown>> };
    const br = await get("br");
    expect(br.budget).toBe("3600.00");
    expect(br.targets).toEqual([{ metricKey: "cpa", targetId: expect.any(String), value: "21", comparator: "lte", source: "inherited", inheritedFrom: env["latam"], impliedVolume: { metric: "conversions", value: "171.43" } }]);
    const mx = await get("mx");
    expect(mx.targets[0]).toMatchObject({ value: "15", source: "own", inheritedFrom: null, impliedVolume: { metric: "conversions", value: "133.33" } });
    const de = await get("de");
    expect(de.targets[0]).toMatchObject({ value: "30", source: "filter", impliedVolume: { metric: "conversions", value: "30.00" } });
  });

  it("the planner resolves the same targets from this module's options (tgt_cpa per row)", async () => {
    const period = { start: "2026-10-01", end: "2026-12-31" };
    const q = QueryRequest.parse({ workspaceId: ws, period: { kind: "range", ...period }, measures: ["budget"], targets: ["cpa"], limit: 100 });
    const ctx = { workspaceId: ws, orgId, userId: planner.id, isOrgAdmin: false, actorType: "user" as const, requestId: rid() };
    const rows = await withTenant(app, ctx, async (tx) => {
      const c = compileQuery(q, period, "2026-11-01", await plannerOptions(tx, { orgId, workspaceId: ws }, q.targets, period));
      return tx.$queryRawUnsafe<Array<Record<string, unknown>>>(c.sql, ...c.values);
    });
    const tgt = Object.fromEntries(rows.map((r) => [String(r["name"]), r["tgt_cpa"] === null ? null : new Decimal(String(r["tgt_cpa"])).toFixed(2)]));
    expect(tgt).toEqual({ LATAM: "21.00", "BR Meta": "21.00", "MX Meta": "15.00", "DE Meta": "30.00" });
  });
});
