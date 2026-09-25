import "../test-support/env.js";
import { randomUUID } from "node:crypto";
import { outbox, withTenant } from "@budget/db";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleInApp } from "./in-app.js";
import { handleSlackEvent, type SlackClient } from "./slack.js";

/**
 * T-021: notify-worker delivery against a fake Slack client (no live Slack call): which events post
 * where, dedupe per outbox id, a failed post retried, and the in-app rows for alerts and approvals.
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
const u = { planner: randomUUID(), owner: randomUUID(), approver: randomUUID(), other: randomUUID() };
const envelopeId = randomUUID();
const ruleIds = { critical: randomUUID(), channel: randomUUID(), quiet: randomUUID() };

class FakeSlack implements SlackClient {
  posts: Array<{ channel: string; text: string }> = [];
  failNext = false;
  async postMessage(m: { channel: string; text: string }) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("slack: ratelimited");
    }
    this.posts.push({ channel: m.channel, text: m.text });
  }
  async lookupUserByEmail(email: string) {
    return email.startsWith("owner") ? "U-OWNER" : null; // the approver is not in Slack
  }
}

/** Writes the event through the real outbox helper and returns it as a Pub/Sub push body. */
async function event(topic: string, payload: Record<string, unknown>) {
  await withTenant(app, { workspaceId: ws, orgId, userId: null, isOrgAdmin: false, actorType: "system", requestId: `t021-${randomUUID()}` }, (tx) => outbox(tx, { workspaceId: ws, topic, payload }));
  const [row] = await owner.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id::text FROM outbox WHERE workspace_id = $1::uuid ORDER BY id DESC LIMIT 1`, ws);
  return { message: { data: Buffer.from(JSON.stringify(payload)).toString("base64"), attributes: { outboxId: row?.id ?? "", workspaceId: ws, orgId, topic }, messageId: randomUUID() }, subscription: "notify-worker" };
}
const notifications = (userId: string) => owner.$queryRawUnsafe<Array<{ kind: string }>>(`SELECT kind FROM notification WHERE workspace_id = $1::uuid AND user_id = $2::uuid ORDER BY created_at`, ws, userId);

async function alert(ruleId: string, severity: string): Promise<string> {
  const id = randomUUID();
  // One open alert per rule and envelope (T-018's unique index): close the previous one first.
  await owner.alert.updateMany({ where: { ruleId, envelopeId, status: "OPEN" }, data: { status: "RESOLVED", resolvedAt: new Date() } });
  await owner.alert.create({ data: { id, workspaceId: ws, ruleId, envelopeId, severity, metricValue: "1.3", threshold: "1.25", context: { budget: "1000.00", actual: "700.00", evaluatedFor: "2026-08-15" }, ownerId: u.owner } });
  return id;
}
async function request(currentStep = 0): Promise<string> {
  const id = randomUUID();
  const versionId = randomUUID();
  await owner.envelopeVersion.create({ data: { id: versionId, envelopeId, versionNo: 1 + Math.floor(Math.random() * 1e6), amount: "1150.00", amountReporting: "1150.00", status: "PENDING", createdBy: u.planner } });
  await owner.approvalRequest.create({
    data: { id, workspaceId: ws, entityType: "envelope_version", entityId: versionId, policyId: randomUUID(), policyVersion: 1, policySnapshot: { policyName: "Standard", chain: [{ role: "APPROVER" }, { role: "FINANCE" }], blockSelfApproval: true, allowExternalEvidence: false, conditions: {} }, currentStep, summary: "BR Meta: 1000.00 → 1150.00", requestedBy: u.planner, dueAt: new Date("2026-09-26T10:00:00Z") },
  });
  return id;
}

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "t021" } });
  await owner.workspace.create({ data: { id: ws, orgId, slug: `t021-${ws}`, name: "T-021", reportingCurrency: "USD", settings: { slack: { defaultChannel: "#budget-ops" } } } });
  await owner.user.createMany({ data: Object.entries(u).map(([k, id]) => ({ id, orgId, email: `${k}-${id}@t021.test`, name: `Name ${k}`, googleSub: `g-${id}` })) });
  await owner.roleAssignment.createMany({
    data: [
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: u.approver, role: "APPROVER", createdBy: u.planner },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: u.planner, role: "PLANNER", createdBy: u.planner },
    ],
  });
  await owner.$executeRawUnsafe(
    `INSERT INTO envelope (id, workspace_id, name, dimension_values, start_date, end_date, currency, status, owner_id, created_by, updated_at) VALUES ($1::uuid, $2::uuid, 'BR Meta', '{}'::jsonb, '2026-01-01', '2026-12-31', 'USD', 'APPROVED', $3::uuid, $4::uuid, now())`,
    envelopeId,
    ws,
    u.owner,
    u.planner,
  );
  const rule = (id: string, name: string, delivery: object) => ({ id, workspaceId: ws, name, metric: "kpi_vs_target_pct", comparator: "gt", threshold: "1.25", severity: "warning", delivery });
  await owner.pacingRule.createMany({ data: [rule(ruleIds.critical, "CPA far over target", { inApp: true }), rule(ruleIds.channel, "Over-pace", { inApp: true, slackChannel: "#latam-pacing" }), rule(ruleIds.quiet, "Quiet", { inApp: true })] });
});

afterAll(async () => {
  for (const sql of [
    `DELETE FROM notification WHERE workspace_id = $1::uuid`,
    `DELETE FROM processed_event WHERE outbox_id IN (SELECT id FROM outbox WHERE workspace_id = $1::uuid)`,
    `DELETE FROM outbox WHERE workspace_id = $1::uuid`,
    `DELETE FROM approval_decision WHERE request_id IN (SELECT id FROM approval_request WHERE workspace_id = $1::uuid)`,
    `DELETE FROM approval_request WHERE workspace_id = $1::uuid`,
    `DELETE FROM alert WHERE workspace_id = $1::uuid`,
    `DELETE FROM pacing_rule WHERE workspace_id = $1::uuid`,
    `DELETE FROM comment WHERE thread_id IN (SELECT id FROM thread WHERE workspace_id = $1::uuid)`,
    `DELETE FROM thread WHERE workspace_id = $1::uuid`,
    `DELETE FROM envelope_version WHERE envelope_id = '${envelopeId}'::uuid`,
    `DELETE FROM envelope WHERE workspace_id = $1::uuid`,
    `DELETE FROM role_assignment WHERE workspace_id = $1::uuid`,
  ]) {
    await owner.$executeRawUnsafe(sql, ws);
  }
  await owner.user.deleteMany({ where: { orgId } });
  await owner.workspace.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("Slack delivery (fake client)", () => {
  it("alerts: a rule channel wins, critical alerts go to the workspace channel, others post nothing", async () => {
    const slack = new FakeSlack();
    const critical = await alert(ruleIds.critical, "critical");
    await handleSlackEvent(app, slack, await event("alert.triggered", { alertId: critical }));
    const routed = await alert(ruleIds.channel, "warning");
    await handleSlackEvent(app, slack, await event("alert.triggered", { alertId: routed }));
    const quiet = await alert(ruleIds.quiet, "warning");
    await handleSlackEvent(app, slack, await event("alert.triggered", { alertId: quiet }));
    expect(slack.posts.map((p) => p.channel)).toEqual(["#budget-ops", "#latam-pacing"]);
    expect(slack.posts[0]?.text).toBe(":rotating_light: CPA far over target — BR Meta");
  });

  it("approvals: new requests and outcomes post; an intermediate approval does not", async () => {
    const slack = new FakeSlack();
    const id = await request();
    await handleSlackEvent(app, slack, await event("approval.changed", { requestId: id, action: "approval.requested", status: "PENDING" }));
    await handleSlackEvent(app, slack, await event("approval.changed", { requestId: id, action: "approval.approve", status: "PENDING" }));
    await owner.approvalDecision.create({ data: { id: randomUUID(), requestId: id, stepIndex: 1, decidedBy: u.approver, decision: "reject", comment: "Not this quarter" } });
    await handleSlackEvent(app, slack, await event("approval.changed", { requestId: id, action: "approval.reject", status: "REJECTED", comment: "Not this quarter" }));
    expect(slack.posts).toEqual([
      { channel: "#budget-ops", text: "📝 Approval requested: BR Meta" },
      { channel: "#budget-ops", text: "⛔ Rejected: BR Meta" },
    ]);
  });

  it("mentions: a direct message to each mentioned Slack user, never to the author", async () => {
    const slack = new FakeSlack();
    const threadId = randomUUID();
    const commentId = randomUUID();
    await owner.thread.create({ data: { id: threadId, workspaceId: ws, anchorType: "envelope", anchorId: envelopeId, title: "Pacing check", createdBy: u.planner } });
    await owner.comment.create({ data: { id: commentId, threadId, authorId: u.planner, bodyMd: `@[user:${u.owner}] @[user:${u.approver}] @[user:${u.planner}] is this right?` } });
    const mentions = [u.owner, u.approver, u.planner].map((id) => ({ type: "user", id }));
    await handleSlackEvent(app, slack, await event("thread.changed", { threadId, commentId, action: "comment.added", actorId: u.planner, anchorType: "envelope", anchorId: envelopeId, mentions }));
    expect(slack.posts).toEqual([{ channel: "U-OWNER", text: "Name planner mentioned you on BR Meta" }]); // the approver has no Slack account
  });

  it("posts once per outbox event; a failed post is not recorded, so the redelivery posts it", async () => {
    const slack = new FakeSlack();
    const body = await event("alert.triggered", { alertId: await alert(ruleIds.critical, "critical") });
    slack.failNext = true;
    await expect(handleSlackEvent(app, slack, body)).rejects.toThrow(/ratelimited/);
    expect((await handleSlackEvent(app, slack, body)).outcome).toBe("applied");
    expect((await handleSlackEvent(app, slack, body)).outcome).toBe("duplicate");
    expect(slack.posts).toHaveLength(1);
  });

  it("without SLACK_BOT_TOKEN nothing is sent and the event is still acknowledged", async () => {
    const res = await handleSlackEvent(app, null, await event("alert.triggered", { alertId: await alert(ruleIds.critical, "critical") }));
    expect(res).toMatchObject({ outcome: "applied", posted: [] });
  });
});

describe("in-app delivery for alerts and approvals", () => {
  it("an alert notifies its owner; a request its step's approvers; an outcome the requester", async () => {
    await handleInApp(app, await event("alert.triggered", { alertId: await alert(ruleIds.quiet, "warning") }));
    expect((await notifications(u.owner)).map((n) => n.kind)).toContain("alert");
    const id = await request();
    await handleInApp(app, await event("approval.changed", { requestId: id, action: "approval.requested", status: "PENDING" }));
    expect((await notifications(u.approver)).map((n) => n.kind)).toEqual(["approval_requested"]);
    expect(await notifications(u.other)).toEqual([]);
    await owner.approvalDecision.create({ data: { id: randomUUID(), requestId: id, stepIndex: 0, decidedBy: u.approver, decision: "approve" } });
    await handleInApp(app, await event("approval.changed", { requestId: id, action: "approval.approve", status: "APPROVED" }));
    expect((await notifications(u.planner)).map((n) => n.kind)).toEqual(["approval_outcome"]);
    expect((await notifications(u.approver)).map((n) => n.kind)).toEqual(["approval_requested"]); // the decider is not told about their own decision
  });
});
