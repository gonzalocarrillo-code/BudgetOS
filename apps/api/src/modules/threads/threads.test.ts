import { randomUUID } from "node:crypto";
import { handleThreadChanged } from "@budget/workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appDb, ownerDb, startHarness, testUser, type Harness, type TestUser } from "../../test-support/harness.js";

/**
 * T-019 done-when: a blocking thread blocks submit; a mention notifies. Threads write
 * `thread.changed` to the outbox; the notify worker's in-app handler (apps/workers) turns the
 * event into notification rows, here fed the outbox row as a Pub/Sub push.
 */

const owner = ownerDb();
const app = appDb();
let h: Harness;
const orgId = randomUUID();
const ws = randomUUID();
const planner = testUser("t019-planner", randomUUID());
const approver = testUser("t019-approver", randomUUID());
const budgetOwner = testUser("t019-owner", randomUUID());
const viewer = testUser("t019-viewer", randomUUID());
const scoped = testUser("t019-scoped", randomUUID());
const admin = testUser("t019-admin", randomUUID());
const outsider = testUser("t019-outsider", randomUUID()); // same org, no role in the workspace
const groupMember = testUser("t019-group", randomUUID());
const orgAdmin = testUser("t019-org", randomUUID());
const groupId = randomUUID();
const X = { "x-workspace-id": ws };
let seq = 0;
const rid = () => `t019-${++seq}-${orgId}`;
const env: Record<string, string> = {};

type Res = { status: number; body: Record<string, unknown> };
async function call(user: TestUser, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown, requestId = rid()): Promise<Res> {
  return h.call(method, `/api/v1${url}`, await h.mint(user), { headers: { ...X, "x-request-id": requestId }, ...(body === undefined ? {} : { body }) });
}
const thread = (user: TestUser, over: Record<string, unknown>, requestId?: string) => call(user, "POST", "/threads", { anchorType: "envelope", anchorId: env["emea"], firstComment: { bodyMd: "Please look" }, ...over }, requestId);
const mention = (u: TestUser) => `@[user:${u.id}]`;
const actions = async (requestId: string) =>
  (await owner.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_event WHERE request_id = $1 ORDER BY occurred_at`, requestId)).map((r) => r.action);
const notifications = async (userId: string) =>
  owner.$queryRawUnsafe<Array<{ kind: string; payload: { threadId: string; action: string } }>>(`SELECT kind, payload FROM notification WHERE workspace_id = $1::uuid AND user_id = $2::uuid ORDER BY created_at`, ws, userId);

/** Delivers the latest thread.changed event for a thread to the in-app notifier, like a Pub/Sub push. */
async function deliver(threadId: string) {
  const [row] = await owner.$queryRawUnsafe<Array<{ id: string; payload: unknown }>>(`SELECT id::text, payload FROM outbox WHERE topic = 'thread.changed' AND payload->>'threadId' = $1 ORDER BY id DESC LIMIT 1`, threadId);
  const body = {
    message: { data: Buffer.from(JSON.stringify(row?.payload)).toString("base64"), attributes: { outboxId: row?.id ?? "", workspaceId: ws, orgId, topic: "thread.changed" }, messageId: randomUUID() },
    subscription: "projects/p/subscriptions/notify-worker",
  };
  return handleThreadChanged(app, body);
}

async function approvedEnvelope(name: string, dimensionValues: Record<string, string>): Promise<string> {
  const created = await call(planner, "POST", `/workspaces/${ws}/envelopes`, { name, dimensionValues, startDate: "2026-10-01", endDate: "2026-12-31", currency: "USD", amount: "1000.00", ownerId: budgetOwner.id });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = String(created.body["id"]);
  const s = await call(planner, "POST", `/envelopes/${id}/submit`, { versionId: created.body["draftVersionId"] });
  expect(s.body["autoApproved"], JSON.stringify(s.body)).toBe(true);
  return id;
}

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "t019" } });
  await owner.workspace.create({ data: { id: ws, orgId, slug: `t019-${ws}`, name: "T-019", reportingCurrency: "USD" } });
  const all = [planner, approver, budgetOwner, viewer, scoped, admin, outsider, groupMember, orgAdmin];
  await owner.user.createMany({ data: all.map((u) => ({ id: u.id, orgId, email: u.email, name: `Name ${u.sub}`, googleSub: `g-${u.sub}` })) });
  await owner.group.create({ data: { id: groupId, orgId, googleGroup: `latam-team-${groupId}@t019.test`, name: "LATAM team" } });
  await owner.groupMember.create({ data: { groupId, userId: groupMember.id } });
  const latam = { logic: "and", children: [{ field: { kind: "dimension", key: "region" }, op: "eq", value: "latam" }] };
  const assign = (u: TestUser, role: string, scope: unknown = {}, principalType = "user", principalId = u.id) => ({ id: randomUUID(), workspaceId: ws, principalType, principalId, role: role as "VIEWER", scope: scope as object, createdBy: orgAdmin.id });
  await owner.roleAssignment.createMany({
    data: [
      assign(planner, "PLANNER"),
      assign(approver, "APPROVER"),
      assign(budgetOwner, "BUDGET_OWNER"),
      assign(viewer, "VIEWER"),
      assign(scoped, "BUDGET_OWNER", latam),
      assign(admin, "WORKSPACE_ADMIN"),
      assign(groupMember, "VIEWER", {}, "group", groupId),
      { id: randomUUID(), workspaceId: null, principalType: "user", principalId: orgAdmin.id, role: "ORG_ADMIN", createdBy: orgAdmin.id },
    ],
  });
  const region = randomUUID();
  await owner.$executeRawUnsafe(`INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by) VALUES ($1::uuid, $2::uuid, NULL, 'region', 'Region', 'ENUM', $3::uuid)`, region, orgId, orgAdmin.id);
  for (const code of ["latam", "emea"]) await owner.$executeRawUnsafe(`INSERT INTO dimension_value (id, dimension_id, code, label) VALUES ($1::uuid, $2::uuid, $3, $3)`, randomUUID(), region, code);
  await owner.approvalPolicy.create({ data: { id: randomUUID(), workspaceId: ws, name: "Auto", priority: 1, conditions: {}, chain: [], blockSelfApproval: true } });
  h = await startHarness();
  env["emea"] = await approvedEnvelope("EMEA", { region: "emea" });
  env["latam"] = await approvedEnvelope("LATAM", { region: "latam" });
}, 60_000);

afterAll(async () => {
  await h?.close();
  const envs = `(SELECT id FROM envelope WHERE workspace_id = $1::uuid)`;
  for (const sql of [
    `DELETE FROM notification WHERE workspace_id = $1::uuid`,
    `DELETE FROM subscription WHERE workspace_id = $1::uuid`,
    `DELETE FROM taggable WHERE workspace_id = $1::uuid`,
    `DELETE FROM tag WHERE workspace_id = $1::uuid`,
    `DELETE FROM comment WHERE thread_id IN (SELECT id FROM thread WHERE workspace_id = $1::uuid)`,
    `DELETE FROM thread WHERE workspace_id = $1::uuid`,
    `DELETE FROM processed_event WHERE outbox_id IN (SELECT id FROM outbox WHERE workspace_id = $1::uuid)`,
    `DELETE FROM approval_decision WHERE request_id IN (SELECT id FROM approval_request WHERE workspace_id = $1::uuid)`,
    `DELETE FROM approval_request WHERE workspace_id = $1::uuid`,
    `DELETE FROM approval_policy WHERE workspace_id = $1::uuid`,
    `UPDATE envelope SET current_version_id = NULL, draft_version_id = NULL WHERE workspace_id = $1::uuid`,
    `DELETE FROM envelope_phasing WHERE version_id IN (SELECT id FROM envelope_version WHERE envelope_id IN ${envs})`,
    `DELETE FROM envelope_version WHERE envelope_id IN ${envs}`,
    `DELETE FROM envelope_dimension WHERE envelope_id IN ${envs}`,
    `DELETE FROM envelope WHERE workspace_id = $1::uuid`,
    `DELETE FROM outbox WHERE workspace_id = $1::uuid`,
  ]) {
    await owner.$executeRawUnsafe(sql, ws);
  }
  await owner.$executeRawUnsafe(`DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`, orgId);
  await owner.$executeRawUnsafe(`DELETE FROM dimension WHERE org_id = $1::uuid`, orgId);
  await owner.roleAssignment.deleteMany({ where: { OR: [{ workspaceId: ws }, { principalId: orgAdmin.id }] } });
  await owner.groupMember.deleteMany({ where: { groupId } });
  await owner.group.delete({ where: { id: groupId } });
  await owner.user.deleteMany({ where: { orgId } });
  await owner.workspace.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("blocking threads (T-019 done-when)", () => {
  it("a blocking thread blocks submit until someone allowed resolves it", async () => {
    const requestId = rid();
    const t = await thread(approver, { isBlocking: true, title: "Hold", firstComment: { bodyMd: "Wait for the Q4 plan" } }, requestId);
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const threadId = String(t.body["id"]);
    expect(await actions(requestId)).toEqual(["thread.created"]);

    const envelope = (await call(planner, "GET", `/envelopes/${env["emea"]}`)).body as { currentVersionId: string };
    const draft = await call(planner, "PATCH", `/envelopes/${env["emea"]}/draft`, { amount: "1100.00", basedOnVersionId: envelope.currentVersionId });
    const blocked = await call(planner, "POST", `/envelopes/${env["emea"]}/submit`, { versionId: draft.body["id"] });
    expect(blocked.status).toBe(409);
    expect(blocked.body["details"]).toMatchObject({ blockingThreads: 1 });

    expect((await call(planner, "POST", `/threads/${threadId}/resolve`)).status).toBe(403); // not author, owner or approver
    const resolved = await call(budgetOwner, "POST", `/threads/${threadId}/resolve`); // the envelope's owner
    expect(resolved.body).toMatchObject({ status: "resolved", resolvedBy: budgetOwner.id });
    const ok = await call(planner, "POST", `/envelopes/${env["emea"]}/submit`, { versionId: draft.body["id"] });
    expect(ok.body, JSON.stringify(ok.body)).toMatchObject({ autoApproved: true });

    expect((await call(approver, "POST", `/threads/${threadId}/comments`, { bodyMd: "late" })).status).toBe(409); // resolved
    expect((await call(approver, "POST", `/threads/${threadId}/reopen`)).body).toMatchObject({ status: "open" });
    expect((await call(approver, "POST", `/threads/${threadId}/resolve`)).body).toMatchObject({ status: "resolved" }); // the author
  });

  it("only envelope and target threads can block; a cell thread needs its month", async () => {
    const alertAnchor = await thread(approver, { anchorType: "alert", anchorId: randomUUID(), isBlocking: true });
    expect(alertAnchor.status).toBe(422);
    expect((await thread(approver, { anchorType: "cell", anchorId: env["emea"] })).status).toBe(422);
    expect((await thread(approver, { anchorType: "cell", anchorId: env["emea"], anchorMeta: { month: "2026-11-01" } })).status).toBe(201);
  });
});

describe("mentions and subscriptions (T-019 done-when: a mention notifies)", () => {
  let threadId: string;

  it("a mention creates a notification for the mentioned user, once, and never for the author", async () => {
    const t = await thread(planner, { firstComment: { bodyMd: `${mention(approver)} can you check this? cc @[group:${groupId}]` } });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    threadId = String(t.body["id"]);
    const first = await deliver(threadId);
    expect(first.notified.sort()).toEqual([approver.id, groupMember.id].sort());
    expect(await notifications(approver.id)).toEqual([expect.objectContaining({ kind: "mention", payload: expect.objectContaining({ threadId, action: "thread.created" }) })]);
    expect(await notifications(groupMember.id)).toHaveLength(1);
    expect(await notifications(planner.id)).toEqual([]);
    expect((await deliver(threadId)).outcome).toBe("duplicate");
    expect(await notifications(approver.id)).toHaveLength(1);
  });

  it("followers of the thread (its commenters) and of the anchor hear about new comments", async () => {
    expect((await call(viewer, "POST", "/subscriptions", { entityType: "envelope", entityId: env["emea"] })).body).toMatchObject({ changed: true });
    const c = await call(approver, "POST", `/threads/${threadId}/comments`, { bodyMd: "Looks fine to me" });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const res = await deliver(threadId);
    expect(res.notified.sort()).toEqual([planner.id, viewer.id].sort()); // the approver wrote it
    expect((await notifications(planner.id)).map((n) => n.kind)).toEqual(["thread_activity"]);
    expect((await call(viewer, "POST", "/subscriptions", { entityType: "envelope", entityId: env["emea"], subscribed: false })).body).toMatchObject({ changed: true });
  });

  it("refuses mentions of users with no role in the workspace", async () => {
    const res = await call(planner, "POST", `/threads/${threadId}/comments`, { bodyMd: `${mention(outsider)} fyi` });
    expect(res.status).toBe(422);
    expect(res.body["details"]).toMatchObject({ users: [outsider.id] });
  });

  it("an edit keeps history and notifies only the newly mentioned; a delete leaves a tombstone", async () => {
    const c = await call(planner, "POST", `/threads/${threadId}/comments`, { bodyMd: `${mention(approver)} numbers?` });
    const id = String(c.body["id"]);
    await deliver(threadId);
    expect((await call(approver, "PATCH", `/comments/${id}`, { bodyMd: "x" })).status).toBe(403);
    const requestId = rid();
    const edited = await call(planner, "PATCH", `/comments/${id}`, { bodyMd: `${mention(approver)} ${mention(budgetOwner)} numbers?` }, requestId);
    expect(edited.body).toMatchObject({ revisions: 1 });
    expect(await actions(requestId)).toEqual(["comment.edited"]);
    const res = await deliver(threadId);
    expect(res.notified).toEqual([budgetOwner.id]);
    expect((await call(viewer, "DELETE", `/comments/${id}`)).status).toBe(403);
    expect((await call(planner, "DELETE", `/comments/${id}`)).body).toMatchObject({ id });
    const threads = (await call(viewer, "GET", `/threads?anchorType=envelope&anchorId=${env["emea"]}`)).body as unknown as Array<{ id: string; comments: Array<{ id: string; bodyMd: string | null; deletedAt: string | null }>; names: { users: Record<string, string>; groups: Record<string, string> } }>;
    const mine = threads.find((t) => t.id === threadId);
    expect(mine?.comments.find((x) => x.id === id)).toMatchObject({ bodyMd: null, deletedAt: expect.any(String) });
    expect(mine?.names.users[approver.id]).toBe(`Name ${approver.sub}`);
    expect(mine?.names.groups[groupId]).toBe("LATAM team");
  });

  it("reading and commenting need the anchor in scope", async () => {
    expect((await call(scoped, "GET", `/threads?anchorType=envelope&anchorId=${env["emea"]}`)).status).toBe(403);
    expect((await thread(scoped, {})).status).toBe(403);
    expect((await thread(scoped, { anchorId: env["latam"] })).status).toBe(201);
    expect((await thread(viewer, { anchorId: env["latam"] })).status).toBe(201); // VIEWER comments (READ has thread.comment)
  });
});

describe("tags", () => {
  it("create (admin), apply and remove in bulk (planner), rename and merge; every write sends tag.changed", async () => {
    expect((await call(planner, "POST", `/workspaces/${ws}/tags`, { name: "q4-push" })).status).toBe(403);
    const a = await call(admin, "POST", `/workspaces/${ws}/tags`, { name: "q4-push", color: "#FF8800" });
    const b = await call(admin, "POST", `/workspaces/${ws}/tags`, { name: "Q4 push" });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect((await call(admin, "POST", `/workspaces/${ws}/tags`, { name: "q4-push" })).status).toBe(409);
    const entities = [{ type: "envelope", id: env["emea"] }, { type: "envelope", id: env["latam"] }];
    const requestId = rid();
    expect((await call(planner, "POST", "/tags/apply", { tagId: a.body["id"], entities }, requestId)).body).toMatchObject({ requested: 2, changed: 2 });
    expect(await actions(requestId)).toEqual(["tag.applied"]);
    expect((await call(planner, "POST", "/tags/apply", { tagId: a.body["id"], entities })).body).toMatchObject({ changed: 0 }); // idempotent
    expect((await call(scoped, "POST", "/tags/apply", { tagId: a.body["id"], entities })).status).toBe(403); // EMEA is outside LATAM
    expect((await call(planner, "POST", "/tags/apply", { tagId: a.body["id"], entities: [{ type: "envelope", id: randomUUID() }] })).status).toBe(422);
    await call(planner, "POST", "/tags/apply", { tagId: b.body["id"], entities: [entities[0]] });

    const merged = await call(admin, "PATCH", `/tags/${String(b.body["id"])}`, { mergeIntoId: a.body["id"] });
    expect(merged.body).toMatchObject({ id: a.body["id"], moved: 0 }); // EMEA already had q4-push
    expect((await call(admin, "PATCH", `/tags/${String(a.body["id"])}`, { name: "Q4 push" })).body).toMatchObject({ name: "Q4 push" });
    expect((await call(planner, "DELETE", "/tags/apply", { tagId: a.body["id"], entities: [entities[1]] })).body).toMatchObject({ changed: 1 });
    const list = (await call(viewer, "GET", `/workspaces/${ws}/tags`)).body as unknown as Array<{ name: string; count: number }>;
    expect(list).toEqual([{ id: a.body["id"], name: "Q4 push", color: "#FF8800", kind: "label", count: 1 }]);
    const events = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE workspace_id = $1::uuid AND topic = 'tag.changed'`, ws);
    expect(Number(events[0]?.n)).toBe(8); // 2 creates, 3 applies, 1 merge, 1 rename, 1 remove
  });
});
