import { randomUUID } from "node:crypto";
import type { TenantContext } from "@budget/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appDb as appDbClient, ownerDb, startHarness, testUser, type Harness, type TestUser } from "../../test-support/harness.js";
import { escalateOverdue } from "./commands/escalate-overdue.js";
import { seedDefaultPolicies } from "./commands/policies.js";

/**
 * Epic 1.3 acceptance (T-011) and the cap trigger test. Each describe quotes one clause of the goal:
 * "Policies configured as in §8.1 route requests through the correct chain; approvers act from the
 * Inbox; external approvals with evidence can be recorded; a request keeps its policy version;
 * overdue requests escalate."
 */

const owner = ownerDb();
const appDb = appDbClient();
let h: Harness;

const orgId = randomUUID();
const ws = randomUUID();
const users = {
  planner: testUser("planner", randomUUID()),
  budgetOwner: testUser("budget-owner", randomUUID()),
  approver: testUser("approver", randomUUID()),
  finance1: testUser("finance1", randomUUID()),
  finance2: testUser("finance2", randomUUID()),
  admin: testUser("admin", randomUUID()),
};
const roles: Record<keyof typeof users, string> = {
  planner: "PLANNER",
  budgetOwner: "BUDGET_OWNER",
  approver: "APPROVER",
  finance1: "FINANCE",
  finance2: "FINANCE",
  admin: "WORKSPACE_ADMIN",
};
const X = { "x-workspace-id": ws };
type Body = Record<string, unknown>;

async function as(u: TestUser, method: "GET" | "POST" | "PATCH", url: string, body?: unknown, requestId?: string) {
  return h.call(method, url, await h.mint(u), { headers: { ...X, ...(requestId ? { "x-request-id": requestId } : {}) }, ...(body === undefined ? {} : { body }) });
}

async function newEnvelope(amount: string, over: Body = {}, by: TestUser = users.planner) {
  const res = await h.call("POST", `/api/v1/workspaces/${ws}/envelopes`, await h.mint(by), {
    body: { name: `E ${randomUUID().slice(0, 6)}`, dimensionValues: { region: "br" }, startDate: "2026-10-01", endDate: "2026-12-31", currency: "USD", amount, ...over },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { id: String(res.body["id"]), draft: String(res.body["draftVersionId"]) };
}
async function submit(envelopeId: string, versionId: string, by: TestUser = users.planner) {
  const res = await as(by, "POST", `/api/v1/envelopes/${envelopeId}/submit`, { versionId });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { autoApproved: boolean; requestId: string | null; policy: { name: string; version: number } };
}
async function decide(requestId: string, by: TestUser, decision = "approve", comment?: string) {
  return as(by, "POST", `/api/v1/approvals/${requestId}/decisions`, { decision, ...(comment ? { comment } : {}) }, `e13-${randomUUID()}`);
}
async function redraft(envelopeId: string, amount: string) {
  const env = (await as(users.planner, "GET", `/api/v1/envelopes/${envelopeId}`)).body;
  const res = await as(users.planner, "PATCH", `/api/v1/envelopes/${envelopeId}/draft`, { amount, basedOnVersionId: env["draftVersionId"] ?? env["currentVersionId"] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return String(res.body["id"]);
}
async function inbox(u: TestUser): Promise<string[]> {
  const res = await as(u, "GET", "/api/v1/approvals?assignee=me&limit=200");
  expect(res.status).toBe(200);
  return (res.body["rows"] as Array<{ id: string }>).map((r) => r.id);
}
async function envelope(id: string) {
  return (await as(users.planner, "GET", `/api/v1/envelopes/${id}`)).body as { status: string; currentVersionId: string | null; draftVersionId: string | null; current: { amount: string } | null };
}
/** Standard: budget owner, then approver. Returns the approved envelope id. */
async function approvedEnvelope(amount: string, over: Body = {}) {
  const e = await newEnvelope(amount, over);
  const s = await submit(e.id, e.draft);
  expect(s.policy.name).toBe("Standard");
  expect((await decide(s.requestId!, users.budgetOwner)).status).toBe(201);
  expect((await decide(s.requestId!, users.approver)).status).toBe(201);
  expect((await envelope(e.id)).status).toBe("APPROVED");
  return e.id;
}

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "epic-1.3" } });
  await owner.workspace.create({ data: { id: ws, orgId, slug: `e13-${ws}`, name: "Epic 1.3", reportingCurrency: "USD" } });
  await owner.user.createMany({ data: Object.values(users).map((u) => ({ id: u.id, orgId, email: u.email, name: u.email, googleSub: `g-${u.sub}` })) });
  await owner.roleAssignment.createMany({
    data: (Object.keys(users) as Array<keyof typeof users>).map((k) => ({ id: randomUUID(), workspaceId: ws, principalType: "user", principalId: users[k].id, role: roles[k] as never, createdBy: users.admin.id })),
  });
  const region = randomUUID();
  await owner.$executeRawUnsafe(`INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by) VALUES ($1::uuid, $2::uuid, NULL, 'region', 'Region', 'ENUM', $3::uuid)`, region, orgId, users.admin.id);
  const latam = randomUUID();
  await owner.$executeRawUnsafe(`INSERT INTO dimension_value (id, dimension_id, code, label) VALUES ($1::uuid, $2::uuid, 'latam', 'LATAM')`, latam, region);
  await owner.$executeRawUnsafe(`INSERT INTO dimension_value (id, dimension_id, code, label, parent_value_id) VALUES ($1::uuid, $2::uuid, 'br', 'Brazil', $3::uuid)`, randomUUID(), region, latam);
  h = await startHarness();
  const ctx: TenantContext = { workspaceId: ws, orgId, userId: users.admin.id, isOrgAdmin: false, actorType: "user", requestId: `e13-seed-${ws}` };
  expect(await seedDefaultPolicies(appDb, ctx)).toBe(5);
}, 60_000);

afterAll(async () => {
  await h?.close();
  const envs = `(SELECT id FROM envelope WHERE workspace_id = $1::uuid)`;
  await owner.$executeRawUnsafe(`DELETE FROM comment WHERE thread_id IN (SELECT id FROM thread WHERE workspace_id = $1::uuid)`, ws);
  await owner.$executeRawUnsafe(`DELETE FROM thread WHERE workspace_id = $1::uuid`, ws);
  await owner.$executeRawUnsafe(`DELETE FROM approval_decision WHERE request_id IN (SELECT id FROM approval_request WHERE workspace_id = $1::uuid)`, ws);
  await owner.$executeRawUnsafe(`DELETE FROM approval_request WHERE workspace_id = $1::uuid`, ws);
  await owner.$executeRawUnsafe(`DELETE FROM approval_policy WHERE workspace_id = $1::uuid`, ws);
  await owner.$executeRawUnsafe(`UPDATE envelope SET current_version_id = NULL, draft_version_id = NULL, parent_id = NULL WHERE workspace_id = $1::uuid`, ws);
  await owner.$executeRawUnsafe(`DELETE FROM envelope_phasing WHERE version_id IN (SELECT id FROM envelope_version WHERE envelope_id IN ${envs})`, ws);
  await owner.$executeRawUnsafe(`DELETE FROM envelope_version WHERE envelope_id IN ${envs}`, ws);
  await owner.$executeRawUnsafe(`DELETE FROM envelope_dimension WHERE envelope_id IN ${envs}`, ws);
  await owner.$executeRawUnsafe(`DELETE FROM envelope WHERE workspace_id = $1::uuid`, ws);
  await owner.$executeRawUnsafe(`DELETE FROM outbox WHERE workspace_id = $1::uuid`, ws);
  await owner.$executeRawUnsafe(`DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`, orgId);
  await owner.$executeRawUnsafe(`DELETE FROM dimension WHERE org_id = $1::uuid`, orgId);
  await owner.roleAssignment.deleteMany({ where: { workspaceId: ws } });
  await owner.user.deleteMany({ where: { orgId } });
  await owner.workspace.delete({ where: { id: ws } });
  await owner.organization.delete({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), appDb.$disconnect()]);
});

describe("Policies configured as in §8.1 route requests through the correct chain", () => {
  it("a new budget under 250k goes to Standard: budget owner, then approver", async () => {
    const e = await newEnvelope("10000.00");
    const s = await submit(e.id, e.draft);
    const r = (await as(users.planner, "GET", `/api/v1/approvals/${s.requestId}`)).body as { policySnapshot: { chain: Array<{ role: string }> }; status: string; summary: string };
    expect(s.policy.name).toBe("Standard");
    expect(r.policySnapshot.chain.map((c) => c.role)).toEqual(["BUDGET_OWNER", "APPROVER"]);
    expect(r.summary).toContain("no approved budget");
    expect((await envelope(e.id)).status).toBe("PENDING");
  });

  it("a change under 2% and 1,000 is auto-approved; under 5% of an amount under 10,000 is a Minor adjustment", async () => {
    const id = await approvedEnvelope("5000.00");
    const auto = await submit(id, await redraft(id, "5050.00"));
    expect(auto).toMatchObject({ autoApproved: true, requestId: null, policy: { name: "Auto-approve minor" } });
    expect((await envelope(id)).current?.amount).toBe("5050.00");
    const minor = await submit(id, await redraft(id, "5200.00"));
    expect(minor.policy.name).toBe("Minor adjustment");
  });

  it("250k and above goes to Major: budget owner, then two finance approvals", async () => {
    const e = await newEnvelope("300000.00");
    const s = await submit(e.id, e.draft);
    expect(s.policy.name).toBe("Major / over-allocation");
    expect((await decide(s.requestId!, users.budgetOwner)).status).toBe(201);
    expect((await decide(s.requestId!, users.finance1)).status).toBe(201);
    expect((await envelope(e.id)).status).toBe("PENDING"); // one of two finance approvals
    expect((await decide(s.requestId!, users.finance1)).status).toBe(409); // same person twice
    expect((await decide(s.requestId!, users.finance2)).status).toBe(201);
    expect((await envelope(e.id)).status).toBe("APPROVED");
  });

  it("an over-allocating child routes to Major even when small", async () => {
    const parent = await approvedEnvelope("1000.00");
    await owner.envelope.update({ where: { id: parent }, data: { allowOverAllocation: true } });
    await approvedEnvelope("600.00", { parentId: parent });
    const child = await newEnvelope("500.00", { parentId: parent });
    expect((await submit(child.id, child.draft)).policy.name).toBe("Major / over-allocation");
  });

  it("reject closes the request and keeps the rejected version; request changes opens a blocking thread", async () => {
    const e = await newEnvelope("2000.00");
    const s1 = await submit(e.id, e.draft);
    expect([400, 422]).toContain((await decide(s1.requestId!, users.budgetOwner, "reject")).status); // comment required
    expect((await decide(s1.requestId!, users.budgetOwner, "reject", "not this quarter")).status).toBe(201);
    const rejected = await owner.envelopeVersion.findUniqueOrThrow({ where: { id: e.draft } });
    expect(rejected.status).toBe("REJECTED");
    expect(await envelope(e.id)).toMatchObject({ status: "DRAFT", draftVersionId: null });

    const v2 = await redraft(e.id, "1800.00");
    const s2 = await submit(e.id, v2);
    expect((await decide(s2.requestId!, users.budgetOwner, "request_changes", "split by month please")).status).toBe(201);
    expect((await owner.envelopeVersion.findUniqueOrThrow({ where: { id: v2 } })).status).toBe("DRAFT");
    const thread = await owner.thread.findFirstOrThrow({ where: { anchorId: e.id, isBlocking: true } });
    const blocked = await as(users.planner, "POST", `/api/v1/envelopes/${e.id}/submit`, { versionId: v2 });
    expect(blocked.status).toBe(409);
    await owner.thread.update({ where: { id: thread.id }, data: { status: "resolved" } }); // thread resolution is T-019
    const s3 = await submit(e.id, v2);
    expect(s3.requestId).not.toBe(s2.requestId);
    expect((await owner.approvalRequest.findUniqueOrThrow({ where: { id: s2.requestId! } })).status).toBe("WITHDRAWN");
  });

  it("each decision writes one approval audit_event and one outbox row; the final one also approves the envelope", async () => {
    const e = await newEnvelope("3000.00");
    const s = await submit(e.id, e.draft);
    await decide(s.requestId!, users.budgetOwner);
    const requestId = `e13-final-${randomUUID()}`;
    const maxId = async () => Number((await owner.$queryRawUnsafe<Array<{ m: bigint | null }>>(`SELECT max(id) AS m FROM outbox`))[0]?.m ?? 0);
    const before = await maxId();
    expect((await as(users.approver, "POST", `/api/v1/approvals/${s.requestId}/decisions`, { decision: "approve" }, requestId)).status).toBe(201);
    const audits = await owner.$queryRawUnsafe<Array<{ action: string; entity_type: string }>>(`SELECT action, entity_type FROM audit_event WHERE request_id = $1 ORDER BY occurred_at`, requestId);
    expect(audits.map((a) => `${a.entity_type}:${a.action}`).sort()).toEqual(["approval_request:approval.approve", "envelope:envelope.version.approved"]);
    const topics = await owner.$queryRawUnsafe<Array<{ topic: string }>>(`SELECT topic FROM outbox WHERE workspace_id = $1::uuid AND id > $2 ORDER BY id`, ws, before);
    expect(topics.map((t) => t.topic).sort()).toEqual(["approval.changed", "budget.changed"]);
  });
});

describe("approvers act from the Inbox", () => {
  it("the inbox shows exactly what the caller may decide now, step by step", async () => {
    const e = await newEnvelope("20000.00");
    const s = await submit(e.id, e.draft);
    const id = s.requestId!;
    expect(await inbox(users.budgetOwner)).toContain(id);
    expect(await inbox(users.approver)).not.toContain(id);
    expect(await inbox(users.planner)).not.toContain(id);
    expect((await decide(id, users.approver)).status).toBe(403); // not their step yet
    expect((await decide(id, users.budgetOwner)).status).toBe(201);
    expect(await inbox(users.budgetOwner)).not.toContain(id);
    expect(await inbox(users.approver)).toContain(id);
  });

  it("separation of duties: the author cannot approve their own version", async () => {
    const e = await newEnvelope("4000.00", {}, users.budgetOwner);
    const s = await submit(e.id, e.draft, users.budgetOwner);
    expect(await inbox(users.budgetOwner)).not.toContain(s.requestId);
    const self = await decide(s.requestId!, users.budgetOwner);
    expect(self.status).toBe(403);
  });
});

describe("external approvals with evidence can be recorded", () => {
  const evidence = { gcsUri: "gs://evidence/client-po.pdf", sha256: "b".repeat(64), approverName: "Client CFO", approvedOn: "2026-09-20" };

  it("counts toward the step when the policy allows it (Standard)", async () => {
    const e = await newEnvelope("7000.00");
    const s = await submit(e.id, e.draft);
    await decide(s.requestId!, users.budgetOwner);
    const res = await as(users.planner, "POST", `/api/v1/approvals/${s.requestId}/external-evidence`, evidence);
    expect(res.status).toBe(201);
    expect(res.body["counted"]).toBe(true);
    expect(res.body["status"]).toBe("APPROVED");
    const d = (res.body["decisions"] as Array<{ decision: string; channel: string; evidence: unknown }>).find((x) => x.decision === "external_evidence");
    expect(d).toMatchObject({ channel: "external_upload", evidence });
  });

  it("is recorded but does not count when the policy does not allow it (Major)", async () => {
    const e = await newEnvelope("400000.00");
    const s = await submit(e.id, e.draft);
    const res = await as(users.planner, "POST", `/api/v1/approvals/${s.requestId}/external-evidence`, evidence);
    expect(res.body).toMatchObject({ counted: false, status: "PENDING", currentStep: 0 });
  });
});

describe("overdue requests escalate", () => {
  it("a step past its due date with escalateTo moves to that role", async () => {
    const e = await newEnvelope("8000.00");
    const s = await submit(e.id, e.draft);
    await decide(s.requestId!, users.budgetOwner); // now at the approver step (escalateTo FINANCE)
    await owner.approvalRequest.update({ where: { id: s.requestId! }, data: { dueAt: new Date(Date.now() - 3_600_000) } });

    const out = await escalateOverdue(appDb);
    expect(out.escalated).toContain(s.requestId);
    const r = (await as(users.planner, "GET", `/api/v1/approvals/${s.requestId}`)).body as { status: string; currentStep: number; policySnapshot: { chain: Array<{ role: string; escalatedFrom?: number }> } };
    expect(r.status).toBe("ESCALATED");
    expect(r.policySnapshot.chain.map((c) => c.role)).toEqual(["BUDGET_OWNER", "APPROVER", "FINANCE"]);
    expect(r.policySnapshot.chain[2]?.escalatedFrom).toBe(1);
    expect(r.currentStep).toBe(2);
    expect(await inbox(users.finance1)).toContain(s.requestId);
    expect(await inbox(users.approver)).not.toContain(s.requestId);
    expect((await escalateOverdue(appDb)).escalated).not.toContain(s.requestId); // escalates once
    expect((await decide(s.requestId!, users.finance1)).status).toBe(201);
    expect((await envelope(e.id)).status).toBe("APPROVED");
  });

  it("a request that is not overdue, or whose step has no escalateTo, is left alone", async () => {
    const e = await newEnvelope("9000.00");
    const s = await submit(e.id, e.draft); // step 0: BUDGET_OWNER, no escalateTo
    await owner.approvalRequest.update({ where: { id: s.requestId! }, data: { dueAt: new Date(Date.now() - 3_600_000) } });
    expect((await escalateOverdue(appDb)).escalated).not.toContain(s.requestId);
  });
});

describe("a request keeps its policy version", () => {
  it("editing a policy bumps its version; open requests keep the chain they were created with", async () => {
    const e = await newEnvelope("11000.00");
    const s = await submit(e.id, e.draft);
    const policies = (await as(users.admin, "GET", `/api/v1/workspaces/${ws}/policies`)).body as unknown as Array<{ id: string; name: string; version: number }>;
    const standard = policies.find((p) => p.name === "Standard")!;
    expect((await as(users.planner, "PATCH", `/api/v1/policies/${standard.id}`, { version: standard.version, chain: [{ role: "FINANCE" }] })).status).toBe(403);
    expect((await as(users.admin, "PATCH", `/api/v1/policies/${standard.id}`, { version: standard.version, chain: [{ role: "FINANCE" }] })).status).toBe(200);
    expect((await as(users.admin, "PATCH", `/api/v1/policies/${standard.id}`, { version: standard.version, priority: 31 })).status).toBe(409); // stale

    const old = (await as(users.planner, "GET", `/api/v1/approvals/${s.requestId}`)).body as { policyVersion: number; policySnapshot: { chain: Array<{ role: string }> } };
    expect(old.policyVersion).toBe(standard.version);
    expect(old.policySnapshot.chain.map((c) => c.role)).toEqual(["BUDGET_OWNER", "APPROVER"]);
    expect((await decide(s.requestId!, users.finance1)).status).toBe(403); // still the old chain
    expect((await decide(s.requestId!, users.budgetOwner)).status).toBe(201);

    const e2 = await newEnvelope("12000.00");
    const s2 = await submit(e2.id, e2.draft);
    expect(s2.policy).toMatchObject({ name: "Standard", version: standard.version + 1 });
    const fresh = (await as(users.planner, "GET", `/api/v1/approvals/${s2.requestId}`)).body as { policySnapshot: { chain: Array<{ role: string }> } };
    expect(fresh.policySnapshot.chain.map((c) => c.role)).toEqual(["FINANCE"]);

    // Restore the template for the tests that follow (version keeps counting up).
    const restore = await as(users.admin, "PATCH", `/api/v1/policies/${standard.id}`, {
      version: standard.version + 1,
      chain: [{ role: "BUDGET_OWNER", minApprovals: 1, timeoutHours: 48 }, { role: "APPROVER", minApprovals: 1, timeoutHours: 72, escalateTo: "FINANCE" }],
    });
    expect(restore.body["version"]).toBe(standard.version + 2);
  });
});

describe("cap trigger: children cannot be approved above the parent", () => {
  it("the service rejects the final approval with CAP_EXCEEDED and nothing changes", async () => {
    const parent = await approvedEnvelope("1000.00");
    const a = await approvedEnvelope("600.00", { parentId: parent });
    const b = await newEnvelope("500.00", { parentId: parent });
    const s = await submit(b.id, b.draft);
    expect(s.policy.name).toBe("Major / over-allocation"); // 600 + 500 > 1000
    await decide(s.requestId!, users.budgetOwner);
    await decide(s.requestId!, users.finance1);
    const last = await decide(s.requestId!, users.finance2);
    expect(last.status).toBe(422);
    expect(last.body["code"]).toBe("CAP_EXCEEDED");
    expect(last.body["details"]).toMatchObject({ parent: "1000.00", children: "1100.00" });
    expect((await envelope(b.id)).status).toBe("PENDING");
    expect((await envelope(a)).current?.amount).toBe("600.00");
    expect(await owner.approvalDecision.count({ where: { requestId: s.requestId!, decidedBy: users.finance2.id } })).toBe(0); // rolled back
  });

  it("the database trigger blocks it even when the service is bypassed", async () => {
    const parent = await approvedEnvelope("1000.00");
    await approvedEnvelope("700.00", { parentId: parent });
    const b = await newEnvelope("400.00", { parentId: parent });
    await expect(owner.$executeRawUnsafe(`UPDATE envelope_version SET status = 'APPROVED', approved_at = now() WHERE id = $1::uuid`, b.draft)).rejects.toThrow(/CAP_EXCEEDED/);
  });

  it("up to the parent amount is fine", async () => {
    const parent = await approvedEnvelope("1000.00");
    await approvedEnvelope("600.00", { parentId: parent });
    const b = await newEnvelope("400.00", { parentId: parent });
    const s = await submit(b.id, b.draft);
    expect(s.policy.name).toBe("Standard");
    await decide(s.requestId!, users.budgetOwner);
    expect((await decide(s.requestId!, users.approver)).status).toBe(201);
    expect((await envelope(b.id)).current?.amount).toBe("400.00");
  });
});
