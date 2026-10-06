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
  async postMessage(m: { channel: string; text: string }): Promise<{ channel: string; ts: string } | void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("slack: ratelimited");
    }
    this.posts.push({ channel: m.channel, text: m.text });
  }
  async lookupUserByEmail(email: string): Promise<string | null> {
    return email.startsWith("owner") ? "U-OWNER" : null; // the approver is not in Slack
  }
}

/** Writes the event through the real outbox helper and returns it as a Pub/Sub push body. */
async function event(topic: string, payload: Record<string, unknown>) {
  await withTenant(app, { workspaceId: ws, orgId, userId: null, isOrgAdmin: false, actorType: "system", requestId: `t021-${randomUUID()}` }, (tx) => outbox(tx, { workspaceId: ws, topic, payload }));
  // W0-5: `id` in ORDER BY must stay qualified (outbox.id, not the `id::text` output column) or
  // Postgres sorts the text alias lexicographically, returning a stale single-digit id once this
  // workspace's own rows pass id 9 (e.g. "9" > "10"). That silently misrouted markProcessed's
  // dedupe key onto an earlier delivery, so the handler never reran and posts/notifications stayed
  // empty — intermittent only because it depends on where this workspace's ids land in the shared
  // bigserial sequence (itself a function of non-deterministic test file ordering).
  const [row] = await owner.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id::text FROM outbox WHERE workspace_id = $1::uuid ORDER BY outbox.id DESC LIMIT 1`, ws);
  return { message: { data: Buffer.from(JSON.stringify(payload)).toString("base64"), attributes: { outboxId: row?.id ?? "", workspaceId: ws, orgId, topic }, messageId: randomUUID() }, subscription: "notify-worker" };
}
const notifications = (userId: string) => owner.$queryRawUnsafe<Array<{ kind: string }>>(`SELECT kind FROM notification WHERE workspace_id = $1::uuid AND user_id = $2::uuid ORDER BY created_at`, ws, userId);

async function alert(ruleId: string, severity: string): Promise<string> {
  const id = randomUUID();
  // One open alert per rule and envelope (T-018's unique index): close the previous one first.
  await owner.alert.updateMany({ where: { ruleId, envelopeId, status: { in: ["OPEN", "ACKNOWLEDGED", "SNOOZED"] } }, data: { status: "RESOLVED", resolvedAt: new Date() } });
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
    `DELETE FROM slack_message WHERE workspace_id = $1::uuid`,
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
  // W3-11 (audit I-32): audit_event.workspace_id is now a FK to workspace(id); the table is
  // append-only (audit_event_immutable trigger), disabled here for cleanup only.
  await owner.$executeRawUnsafe("ALTER TABLE audit_event DISABLE TRIGGER audit_event_immutable");
  // org_id (for most rows) and workspace_id (belt and braces, in case a row was ever written
  // without the session's app.org_id set, so it never got the migration's DEFAULT backfill).
  await owner.$executeRawUnsafe("DELETE FROM audit_event WHERE org_id = $1::uuid OR workspace_id = $2::uuid", orgId, ws);
  await owner.$executeRawUnsafe("ALTER TABLE audit_event ENABLE TRIGGER audit_event_immutable");
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

  it("posts once per outbox event; a post that fails after the decision to send it commits is retried on redelivery, not re-decided (I-21)", async () => {
    const slack = new FakeSlack();
    const body = await event("alert.triggered", { alertId: await alert(ruleIds.critical, "critical") });
    slack.failNext = true;
    // The consumer transaction (deciding to post, and recording that) already committed by the time
    // Slack is called, so this throw is the post itself failing, not the business logic.
    await expect(handleSlackEvent(app, slack, body)).rejects.toThrow(/ratelimited/);
    expect(slack.posts).toHaveLength(0);
    // Redelivery of the same event: the handler is not re-run (the event was already applied), but
    // the still-unsent post is retried and this time succeeds.
    expect((await handleSlackEvent(app, slack, body)).outcome).toBe("duplicate");
    expect(slack.posts).toHaveLength(1);
    // A further redelivery finds nothing left to send.
    expect((await handleSlackEvent(app, slack, body)).outcome).toBe("duplicate");
    expect(slack.posts).toHaveLength(1);
  });

  it("a failure on the second of two posts leaves the first's ts recorded; redelivery posts only the missing one (I-21)", async () => {
    const slack = new FakeSlack();
    const requestId = await request();
    const body = await event("approval.changed", { requestId, action: "approval.requested", status: "PENDING" });
    // Two posts for one event: the channel, and the approver's direct message (owner is in Slack as U-OWNER; the approver is not, so give the approver a Slack identity for this test).
    const originalLookup = slack.lookupUserByEmail.bind(slack);
    slack.lookupUserByEmail = async (email: string) => (email.startsWith("owner") || email.startsWith("approver") ? (email.startsWith("owner") ? "U-OWNER" : "U-APPROVER") : null);
    let calls = 0;
    const originalPost = slack.postMessage.bind(slack);
    slack.postMessage = async (m: { channel: string; text: string }) => {
      calls += 1;
      if (calls === 2) throw new Error("slack: ratelimited");
      return originalPost(m);
    };
    await expect(handleSlackEvent(app, slack, body)).rejects.toThrow(/ratelimited/);
    const afterFailure = await owner.$queryRawUnsafe<Array<{ ts: string | null }>>(`SELECT ts FROM slack_delivery WHERE outbox_id = $1::bigint ORDER BY channel`, body.message.attributes.outboxId);
    expect(afterFailure.filter((r) => r.ts !== null)).toHaveLength(1); // the first post's ts is recorded; the second's is still null
    expect(slack.posts).toHaveLength(1);

    const redelivered = await handleSlackEvent(app, slack, body);
    expect(redelivered.outcome).toBe("duplicate");
    expect(slack.posts).toHaveLength(2); // only the missing one was retried
    const afterRetry = await owner.$queryRawUnsafe<Array<{ ts: string | null }>>(`SELECT ts FROM slack_delivery WHERE outbox_id = $1::bigint`, body.message.attributes.outboxId);
    expect(afterRetry.every((r) => r.ts !== null)).toBe(true);

    slack.lookupUserByEmail = originalLookup;
  });

  it("without SLACK_BOT_TOKEN nothing is sent and the event is still acknowledged", async () => {
    const res = await handleSlackEvent(app, null, await event("alert.triggered", { alertId: await alert(ruleIds.critical, "critical") }));
    expect(res).toMatchObject({ outcome: "applied", posted: [] });
  });
});

/** A fake that answers like chat.postMessage (channel + ts) and records chat.update edits. */
class RecordingSlack extends FakeSlack {
  sent: Array<{ channel: string; ts: string; text: string; blocks: unknown[] }> = [];
  edits: Array<{ channel: string; ts: string; text: string; blocks: unknown[] }> = [];
  override async postMessage(m: { channel: string; text: string; blocks?: unknown[] }) {
    await super.postMessage(m);
    const ref = { channel: m.channel.replace(/^#/, "C-"), ts: `${Date.now()}.${this.sent.length}` };
    this.sent.push({ ...ref, text: m.text, blocks: m.blocks ?? [] });
    return ref;
  }
  async updateMessage(m: { channel: string; ts: string; text: string; blocks: unknown[] }) {
    this.edits.push(m);
  }
}
const actionIds = (blocks: unknown[]) => JSON.stringify(blocks).match(/"action_id":"[a-z_.]+"/g) ?? [];

describe("Slack bot: buttons, routing and keeping messages current (feedback 2026-09-28)", () => {
  beforeAll(async () => {
    await owner.workspace.update({ where: { id: ws }, data: { settings: { slack: { defaultChannel: "#budget-ops", alertChannel: "#alerts", alertSeverities: ["warning", "critical"], teamId: "T0TEST" } } } });
  });
  afterAll(async () => {
    await owner.workspace.update({ where: { id: ws }, data: { settings: { slack: { defaultChannel: "#budget-ops" } } } });
  });

  it("an alert posts with Acknowledge / Snooze / Resolve; when it changes, the same message is edited", async () => {
    const slack = new RecordingSlack();
    const id = await alert(ruleIds.quiet, "warning"); // no rule channel: the workspace's alert channel takes warnings
    await handleSlackEvent(app, slack, await event("alert.triggered", { alertId: id }));
    expect(slack.sent.map((m) => m.channel)).toEqual(["C-alerts"]);
    expect(actionIds(slack.sent[0]?.blocks ?? [])).toEqual(['"action_id":"alert.acknowledge"', '"action_id":"alert.snooze"', '"action_id":"alert.resolve"', '"action_id":"open_alert"', '"action_id":"open_envelope"']);

    await owner.alert.update({ where: { id }, data: { status: "ACKNOWLEDGED" } });
    await owner.$executeRawUnsafe(`INSERT INTO audit_event (id, workspace_id, actor_id, actor_type, action, entity_type, entity_id, after, request_id) VALUES ($1::uuid, $2::uuid, $3::uuid, 'user', 'alert.acknowledged', 'alert', $4::uuid, '{}'::jsonb, 'slack-test')`, randomUUID(), ws, u.owner, id);
    const res = await handleSlackEvent(app, slack, await event("alert.changed", { alertId: id, status: "ACKNOWLEDGED" }));
    expect(res.posted).toEqual([]);
    expect(slack.edits.map((e) => [e.channel, e.ts])).toEqual([[slack.sent[0]?.channel, slack.sent[0]?.ts]]);
    expect(JSON.stringify(slack.edits[0]?.blocks)).toContain("Acknowledged by Name owner");
    expect(actionIds(slack.edits[0]?.blocks ?? [])).not.toContain('"action_id":"alert.acknowledge"');
  });

  it("a request posts with Approve / Reject; its outcome edits that message instead of posting again", async () => {
    const slack = new RecordingSlack();
    const id = await request();
    await handleSlackEvent(app, slack, await event("approval.changed", { requestId: id, action: "approval.requested", status: "PENDING" }));
    expect(actionIds(slack.sent[0]?.blocks ?? [])).toEqual(['"action_id":"approval.approve"', '"action_id":"approval.changes"', '"action_id":"approval.reject"', '"action_id":"open_approval"']);
    await owner.approvalDecision.create({ data: { id: randomUUID(), requestId: id, stepIndex: 1, decidedBy: u.approver, decision: "approve" } });
    const res = await handleSlackEvent(app, slack, await event("approval.changed", { requestId: id, action: "approval.approve", status: "APPROVED" }));
    expect(res.posted).toEqual([]);
    expect(slack.edits).toHaveLength(1);
    expect(slack.edits[0]?.text).toBe("✅ Approved: BR Meta");
    expect(actionIds(slack.edits[0]?.blocks ?? [])).toEqual(['"action_id":"open_approval"']);
  });

  it("a test message goes to the channel asked for", async () => {
    const slack = new RecordingSlack();
    await handleSlackEvent(app, slack, await event("slack.test", { channel: "#budget-ops", requestedBy: "Name planner" }));
    expect(slack.sent.map((m) => [m.channel, m.text])).toEqual([["C-budget-ops", ":white_check_mark: BudgetOS is connected"]]);
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

/** Every user of the fixture is in Slack as U-<name>; a direct message goes to D-<slack user>. */
class DmSlack implements SlackClient {
  sent: Array<{ channel: string; ts: string; text: string; blocks: unknown[] }> = [];
  edits: Array<{ channel: string; ts: string; text: string }> = [];
  async postMessage(m: { channel: string; text: string; blocks?: unknown[] }) {
    const ref = { channel: m.channel.replace(/^#/, "C-"), ts: `${Date.now()}.${this.sent.length}` };
    this.sent.push({ ...ref, text: m.text, blocks: m.blocks ?? [] });
    return ref;
  }
  async updateMessage(m: { channel: string; ts: string; text: string }) {
    this.edits.push({ channel: m.channel, ts: m.ts, text: m.text });
  }
  async lookupUserByEmail(email: string) {
    return `U-${email.split("-")[0]}`;
  }
  async openDm(slackUserId: string) {
    return `D-${slackUserId}`;
  }
}

describe("direct messages to approvers and requesters (S-004)", () => {
  const more = { approver2: randomUUID(), finance: randomUUID() };
  const recorded = (requestId: string) => owner.$queryRawUnsafe<Array<{ channel: string }>>(`SELECT channel FROM slack_message WHERE entity_id = $1::uuid ORDER BY channel`, requestId);
  beforeAll(async () => {
    await owner.workspace.update({ where: { id: ws }, data: { settings: { slack: { defaultChannel: "#budget-ops", teamId: "T0TEST" } } } });
    await owner.user.createMany({ data: Object.entries(more).map(([k, id]) => ({ id, orgId, email: `${k}-${id}@t021.test`, name: `Name ${k}`, googleSub: `g-${id}` })) });
    await owner.roleAssignment.createMany({
      data: [
        { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: more.approver2, role: "APPROVER", createdBy: u.planner },
        { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: more.finance, role: "FINANCE", createdBy: u.planner },
      ],
    });
  });
  afterAll(async () => {
    await owner.workspace.update({ where: { id: ws }, data: { settings: { slack: { defaultChannel: "#budget-ops" } } } });
  });

  it("a new request goes to the channel and to each approver of its step, and its outcome edits them all and tells the requester", async () => {
    const slack = new DmSlack();
    const id = await request();
    await handleSlackEvent(app, slack, await event("approval.changed", { requestId: id, action: "approval.requested", status: "PENDING" }));
    expect(slack.sent.map((m) => m.channel).sort()).toEqual(["C-budget-ops", "D-U-approver", "D-U-approver2"]);
    expect(JSON.stringify(slack.sent.find((m) => m.channel === "D-U-approver")?.blocks)).toContain('"action_id":"approval.approve"');
    expect((await recorded(id)).map((r) => r.channel)).toEqual(["C-budget-ops", "D-U-approver", "D-U-approver2"]);

    await owner.approvalRequest.update({ where: { id }, data: { status: "APPROVED" } });
    await owner.approvalDecision.create({ data: { id: randomUUID(), requestId: id, stepIndex: 0, decidedBy: u.approver, decision: "approve" } });
    await owner.$executeRawUnsafe(`INSERT INTO audit_event (id, workspace_id, actor_id, actor_type, action, entity_type, entity_id, after, request_id) VALUES ($1::uuid, $2::uuid, $3::uuid, 'user', 'approval.approve', 'approval_request', $4::uuid, '{}'::jsonb, 's004')`, randomUUID(), ws, u.approver, id);
    const outcome = await handleSlackEvent(app, slack, await event("approval.changed", { requestId: id, action: "approval.approve", status: "APPROVED" }));
    expect(slack.edits.map((e) => e.channel).sort()).toEqual(["C-budget-ops", "D-U-approver", "D-U-approver2"]);
    expect(slack.edits.every((e) => e.text === "✅ Approved: BR Meta")).toBe(true);
    // The requester hears the outcome; the approver who decided does not.
    expect(outcome.posted.map((o) => o.channel)).toEqual(["D-U-planner"]);
  });

  it("an approval that completes its step edits the posts and tells the next step's approvers", async () => {
    const slack = new DmSlack();
    const id = await request();
    await handleSlackEvent(app, slack, await event("approval.changed", { requestId: id, action: "approval.requested", status: "PENDING" }));
    await owner.approvalRequest.update({ where: { id }, data: { currentStep: 1 } });
    const advanced = await handleSlackEvent(app, slack, await event("approval.changed", { requestId: id, action: "approval.approve", status: "PENDING", step: 0 }));
    expect(advanced.posted.map((o) => o.channel)).toEqual(["D-U-finance"]);
    expect(slack.edits.map((e) => e.channel).sort()).toEqual(["C-budget-ops", "D-U-approver", "D-U-approver2"]);
    // A second approval on a step that needs more is nothing new.
    const waiting = await handleSlackEvent(app, slack, await event("approval.changed", { requestId: id, action: "approval.approve", status: "PENDING", step: 1 }));
    expect(waiting.posted).toEqual([]);
  });

  it("a reminder sends the current step's approvers a new direct message", async () => {
    const slack = new DmSlack();
    const id = await request();
    await handleSlackEvent(app, slack, await event("approval.changed", { requestId: id, action: "approval.requested", status: "PENDING" }));
    const reminded = await handleSlackEvent(app, slack, await event("approval.reminded", { requestId: id, step: 0, by: u.planner }));
    expect(reminded.posted.map((o) => o.channel).sort()).toEqual(["D-U-approver", "D-U-approver2"]);
    expect(reminded.posted[0]?.message.text).toMatch(/^⏰ Reminder/);
    expect(slack.edits).toEqual([]);
  });

  it("with direct messages turned off, only the channel hears of it", async () => {
    await owner.workspace.update({ where: { id: ws }, data: { settings: { slack: { defaultChannel: "#budget-ops", teamId: "T0TEST", dms: false } } } });
    try {
      const slack = new DmSlack();
      const id = await request();
      await handleSlackEvent(app, slack, await event("approval.changed", { requestId: id, action: "approval.requested", status: "PENDING" }));
      expect(slack.sent.map((m) => m.channel)).toEqual(["C-budget-ops"]);
    } finally {
      await owner.workspace.update({ where: { id: ws }, data: { settings: { slack: { defaultChannel: "#budget-ops", teamId: "T0TEST" } } } });
    }
  });

  it("in the app too: the next step's approvers when a step completes, and the approvers again on a reminder", async () => {
    const id = await request();
    await owner.approvalRequest.update({ where: { id }, data: { currentStep: 1 } });
    await handleInApp(app, await event("approval.changed", { requestId: id, action: "approval.approve", status: "PENDING", step: 0 }));
    expect((await notifications(more.finance)).map((n) => n.kind)).toEqual(["approval_requested"]);
    const second = await request();
    const before = (await notifications(more.approver2)).length;
    await handleInApp(app, await event("approval.reminded", { requestId: second, step: 0, by: u.planner }));
    expect((await notifications(more.approver2)).length).toBe(before + 1);
  });
});

