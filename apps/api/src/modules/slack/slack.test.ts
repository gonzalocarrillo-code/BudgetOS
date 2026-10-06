import { randomUUID } from "node:crypto";
import { shortRequestId } from "@budget/domain";
import { handleInApp, handleSlackEvent, type SlackClient } from "@budget/workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGolden, type GoldenResult } from "../../seed/golden.js";
import { cleanupGolden } from "../../test-support/golden-cleanup.js";
import { appDb, ownerDb, startHarness, type Harness } from "../../test-support/harness.js";
import { paceOf, percent, wholeMoney } from "./blocks/format.js";
import { resetSlackReplayCache, signSlackBody } from "./signature.js";
import { setSlackResponder } from "./respond.js";
import { setCommandDeadline } from "./slash/index.js";
import { setSlackApi, type SlackApi } from "./slack-api.js";

/**
 * Slack bot (product feedback 2026-09-28, ADR-046) on the golden workspace, with a fake Slack:
 * signed requests only; a Slack user acts as the Budget OS account with their email, in a
 * workspace linked to their Slack team, through the same commands (and checks) as the app.
 */

const owner = ownerDb();
const app = appDb();
let h: Harness;
let golden: GoldenResult;
const slug = `slack-${randomUUID().slice(0, 8)}`;
const SECRET = "test-signing-secret";
const TEAM = "T0GOLDEN1";
const email = (p: string) => `${p.toLowerCase()}@${slug}.golden.test`;
const views: Array<{ trigger: string; view: Record<string, unknown> }> = [];
// S-14: a Slack user id's email is normally a pure function of the id (below), but an impersonation
// test needs two different Slack user ids to resolve to the same email, or the same id to resolve to
// two different emails over time — exactly what a Slack profile edit can do. This override wins.
const slackEmailOverrides = new Map<string, string>();
const fake: SlackApi = {
  // "U-<persona>" is that persona; "U-CAPS-<persona>" has the same email in capitals, as some Slack
  // profiles do; "U-SLOW-<persona>" answers after 300 ms, like a slow Slack (S-012).
  userEmail: async (slackUserId) => {
    if (slackEmailOverrides.has(slackUserId)) return slackEmailOverrides.get(slackUserId) ?? null;
    if (slackUserId.startsWith("U-SLOW-")) {
      await new Promise((r) => setTimeout(r, 300));
      return email(slackUserId.slice(7));
    }
    return slackUserId.startsWith("U-CAPS-") ? email(slackUserId.slice(7)).toUpperCase() : slackUserId.startsWith("U-") ? email(slackUserId.slice(2)) : null;
  },
  openView: async (trigger, view) => void views.push({ trigger, view }),
  team: async () => ({ id: TEAM, name: "Golden Slack" }),
};

async function as(persona: string, method: "GET" | "POST" | "PATCH", url: string, body?: unknown) {
  const token = await h.mint({ sub: `ip-${persona}`, email: email(persona) }, { googleSub: `golden-${slug}-${persona}` });
  return h.call(method, `/api/v1${url}`, token, { headers: { "x-workspace-id": golden.workspaceId }, ...(body === undefined ? {} : { body }) });
}
// S-15's replay cache keys on (timestamp, signature): two genuinely distinct test requests built in
// the same wall-clock second would otherwise collide if both let `signSlackBody` default its
// timestamp to `Date.now()`. Strictly increasing defaults (never reused) avoid that, while a test
// that wants a real replay still passes an explicit `timestamp` to force the collision.
let nextDefaultTimestamp = Math.floor(Date.now() / 1000);
/** What Slack sends: a form body, signed. */
async function slack(path: "interactions" | "commands", fields: Record<string, string>, opts: { secret?: string; timestamp?: number; headers?: Record<string, string> } = {}) {
  const timestamp = opts.timestamp ?? (nextDefaultTimestamp = Math.max(Math.floor(Date.now() / 1000), nextDefaultTimestamp + 1));
  const raw = new URLSearchParams(fields).toString();
  const res = await h.app.getHttpAdapter().getInstance().inject({ method: "POST", url: `/api/v1/slack/${path}`, headers: { "content-type": "application/x-www-form-urlencoded", ...signSlackBody(opts.secret ?? SECRET, raw, timestamp), ...opts.headers }, payload: raw });
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {} };
}
const click = (persona: string, actionId: string, id: string, team = TEAM) =>
  slack("interactions", { payload: JSON.stringify({ type: "block_actions", team: { id: team }, user: { id: `U-${persona}` }, trigger_id: `trig-${randomUUID()}`, actions: [{ action_id: actionId, value: JSON.stringify({ ws: golden.workspaceId, id }) }] }) });

/** What the API answered through response_urls (S-006); `failNext` makes Slack refuse one. */
const responses: Array<{ url: string; body: Record<string, unknown> }> = [];
let failNextResponse = false;

beforeAll(async () => {
  process.env["SLACK_SIGNING_SECRET"] = SECRET;
  setSlackApi(fake);
  setSlackResponder({
    respond: async (url, body) => {
      if (failNextResponse) {
        failNextResponse = false;
        throw new Error("expired_url");
      }
      responses.push({ url, body });
    },
  });
  golden = await seedGolden(app, owner, { slug });
  h = await startHarness();
}, 180_000);

afterAll(async () => {
  setSlackApi(undefined);
  setSlackResponder(undefined);
  delete process.env["SLACK_SIGNING_SECRET"];
  await h?.close();
  if (golden?.created) await cleanupGolden(owner, golden);
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("Slack settings", () => {
  it("the org admin links the org once; every workspace answers to that team; members read, admins route (audited)", async () => {
    const read = await as("planner", "GET", `/workspaces/${golden.workspaceId}/integrations/slack`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ connected: false, team: null });
    expect(read.body).not.toHaveProperty("manifest");
    // R11-002: the connection is the org's: only an org admin links it, once.
    expect((await as("admin", "PATCH", "/org/integrations/slack", { link: true })).status).toBe(403);
    const org = await as("orgAdmin", "GET", "/org/integrations/slack");
    expect(org.body).toMatchObject({ secrets: { signingSecret: true }, team: null, urls: { interactions: expect.stringMatching(/\/api\/v1\/slack\/interactions$/) } });
    const linked = await as("orgAdmin", "PATCH", "/org/integrations/slack", { link: true });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expect(linked.body).toMatchObject({ teamId: TEAM, teamName: "Golden Slack" });
    const [audited] = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM audit_event WHERE entity_id = $1::uuid AND action = 'slack.org_linked'`, golden.orgId);
    expect(Number(audited?.n)).toBe(1);
    // A workspace that never touched Slack is linked through its org.
    expect((await as("planner", "GET", `/workspaces/${golden.workspaceId}/integrations/slack`)).body).toMatchObject({ connected: true, team: { id: TEAM, name: "Golden Slack" } });

    expect((await as("planner", "PATCH", `/workspaces/${golden.workspaceId}/integrations/slack`, { defaultChannel: "#budget" })).status).toBe(403);
    expect((await as("admin", "PATCH", `/workspaces/${golden.workspaceId}/integrations/slack`, { link: true })).status).toBe(422);
    const set = await as("admin", "PATCH", `/workspaces/${golden.workspaceId}/integrations/slack`, { defaultChannel: "#budget", alertChannel: "#alerts", alertSeverities: ["warning", "critical"] });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toMatchObject({ defaultChannel: "#budget", alertChannel: "#alerts", alertSeverities: ["warning", "critical"], dms: true });
    // S-004: direct messages to approvers and requesters can be turned off, and back on.
    expect((await as("admin", "PATCH", `/workspaces/${golden.workspaceId}/integrations/slack`, { dms: false })).body).toMatchObject({ dms: false, defaultChannel: "#budget" });
    expect(((await as("planner", "GET", `/workspaces/${golden.workspaceId}/integrations/slack`)).body["settings"] as { dms: boolean }).dms).toBe(false);
    expect((await as("admin", "PATCH", `/workspaces/${golden.workspaceId}/integrations/slack`, { dms: true })).body).toMatchObject({ dms: true });
    const test = await as("admin", "POST", `/workspaces/${golden.workspaceId}/integrations/slack/test`, {});
    expect(test.body).toMatchObject({ queued: true, channel: "#budget" });
    const orgTest = await as("orgAdmin", "POST", "/org/integrations/slack/test", { channel: "#general" });
    expect(orgTest.body).toMatchObject({ queued: true, channel: "#general" });
    const [q] = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE workspace_id = $1::uuid AND topic = 'slack.test'`, golden.workspaceId);
    expect(Number(q?.n)).toBe(2);
  });
});

describe("Slack requests", () => {
  it("refuses unsigned, wrongly signed and stale requests", async () => {
    const res = await h.app.getHttpAdapter().getInstance().inject({ method: "POST", url: "/api/v1/slack/commands", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "text=help" });
    expect(res.statusCode).toBe(403);
    expect((await slack("commands", { text: "help" }, { secret: "wrong" })).status).toBe(403);
    expect((await slack("commands", { text: "help" }, { timestamp: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(403);
    expect((await slack("commands", { text: "help", team_id: TEAM, user_id: "U-planner" })).body["text"]).toContain("/budget alerts");
  });

  it("acknowledges and snoozes an alert from its buttons, as the Slack user's account", async () => {
    const [alert] = await owner.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id::text FROM alert WHERE workspace_id = $1::uuid AND status = 'OPEN' ORDER BY opened_at LIMIT 1`, golden.workspaceId);
    expect(alert).toBeDefined();
    expect((await click("admin", "alert.acknowledge", alert!.id)).status).toBe(200);
    const [row] = await owner.$queryRawUnsafe<Array<{ status: string }>>(`SELECT status::text FROM alert WHERE id = $1::uuid`, alert!.id);
    expect(row?.status).toBe("ACKNOWLEDGED");
    const [a] = await owner.$queryRawUnsafe<Array<{ actor_id: string }>>(`SELECT actor_id::text FROM audit_event WHERE entity_id = $1::uuid AND action LIKE 'alert.%' ORDER BY occurred_at DESC LIMIT 1`, alert!.id);
    expect(a?.actor_id).toBe(golden.users.admin);
    await click("admin", "alert.snooze", alert!.id);
    const [snoozed] = await owner.$queryRawUnsafe<Array<{ status: string }>>(`SELECT status::text FROM alert WHERE id = $1::uuid`, alert!.id);
    expect(snoozed?.status).toBe("SNOOZED");

    // Another Slack team, or a Slack user with no Budget OS account: nothing changes; they are told why.
    views.length = 0;
    await click("admin", "alert.resolve", alert!.id, "T0OTHER99");
    await click("stranger", "alert.resolve", alert!.id);
    const [still] = await owner.$queryRawUnsafe<Array<{ status: string }>>(`SELECT status::text FROM alert WHERE id = $1::uuid`, alert!.id);
    expect(still?.status).toBe("SNOOZED");
    expect(views.map((v) => JSON.stringify(v.view))).toEqual([expect.stringContaining("not linked"), expect.stringContaining("No active BudgetOS account")]);
  });

  it("approves from Slack, and rejects with a reason through the form", async () => {
    // A second request to reject: a large raise, sent for approval (the first budget the policies do not auto-approve).
    for (const envelopeId of [...golden.envelopeIds.values()].slice(0, 20)) {
      const env = (await as("planner", "GET", `/envelopes/${envelopeId}`)).body as { current?: { id: string; amount: string } | null; draft?: unknown; status?: string };
      if (!env.current || env.draft || env.status !== "APPROVED") continue;
      const draft = await as("planner", "PATCH", `/envelopes/${envelopeId}/draft`, { amount: (Number(env.current.amount) * 3 + 100000).toFixed(2), basedOnVersionId: env.current.id });
      if (draft.status !== 200) continue;
      const sent = await as("planner", "POST", `/envelopes/${envelopeId}/submit`, { versionId: draft.body["id"] });
      if (sent.body["autoApproved"] === false) break;
    }
    const inbox = (await as("orgAdmin", "GET", "/approvals?assignee=me&limit=10")).body as { rows: Array<{ id: string }> };
    expect(inbox.rows.length, "an org admin may decide every open request").toBeGreaterThanOrEqual(2);
    const first = inbox.rows[0]!.id;
    await click("orgAdmin", "approval.approve", first);
    const [d] = await owner.$queryRawUnsafe<Array<{ decision: string; channel: string; decided_by: string }>>(`SELECT decision::text, channel::text, decided_by::text FROM approval_decision WHERE request_id = $1::uuid ORDER BY decided_at DESC LIMIT 1`, first);
    expect(d).toMatchObject({ decision: "approve", channel: "slack", decided_by: golden.users.orgAdmin });
    // The org admin holds no role of their own here: the audit row says they acted as a superadmin (ADR-052), as in the app.
    const [trail] = await owner.$queryRawUnsafe<Array<{ actor_context: string | null }>>(`SELECT actor_context FROM audit_event WHERE entity_id = $1::uuid AND action = 'approval.approve'`, first);
    expect(trail?.actor_context).toBe("superadmin");

    const next = (await as("orgAdmin", "GET", "/approvals?assignee=me&limit=10")).body as { rows: Array<{ id: string }> };
    const other = next.rows.find((r) => r.id !== first);
    expect(other).toBeDefined();
    if (!other) return;
    views.length = 0;
    await click("orgAdmin", "approval.reject", other.id);
    expect(views[0]?.view).toMatchObject({ callback_id: "approval.reject" });
    const submit = (reason: string) =>
      slack("interactions", { payload: JSON.stringify({ type: "view_submission", team: { id: TEAM }, user: { id: "U-orgAdmin" }, view: { callback_id: "approval.reject", private_metadata: views[0]?.view["private_metadata"], state: { values: { reason: { reason: { value: reason } } } } } }) });
    expect((await submit("")).body).toMatchObject({ response_action: "errors" });
    expect((await submit("Over the Q4 cap")).body).toEqual({});
    const [r] = await owner.$queryRawUnsafe<Array<{ decision: string; comment: string }>>(`SELECT decision::text, comment FROM approval_decision WHERE request_id = $1::uuid ORDER BY decided_at DESC LIMIT 1`, other.id);
    expect(r).toMatchObject({ decision: "reject", comment: "Over the Q4 cap" });
  });

  it("/budget: alerts, search and a budget's numbers, only what the person may see", async () => {
    const alerts = await slack("commands", { text: "alerts", team_id: TEAM, user_id: "U-admin" });
    expect(alerts.status).toBe(200);
    expect(JSON.stringify(alerts.body)).toMatch(/open alerts/i);
    const budget = await slack("commands", { text: "brazil", team_id: TEAM, user_id: "U-planner" });
    expect(budget.body).toMatchObject({ response_type: "ephemeral" });
    // S-009: a budget's card, or a choice when several match.
    expect(JSON.stringify(budget.body)).toMatch(/Which “brazil”\?|\*Budget\*/);
    const nobody = await slack("commands", { text: "alerts", team_id: TEAM, user_id: "U-stranger" });
    expect(String(nobody.body["text"])).toContain("No BudgetOS workspace");
  });

  it("/budget search and /budget list <text> show the same numbers as the one query path (T-8, audit)", async () => {
    // T-014's split part: a live, distinctively-named budget with its own approved amount and spend.
    const hit = await owner.envelope.findFirstOrThrow({ where: { workspaceId: golden.workspaceId, status: "APPROVED", name: { contains: "Walmart" } }, select: { id: true } });
    const direct = (await as(
      "admin",
      "POST",
      `/workspaces/${golden.workspaceId}/query`,
      { workspaceId: golden.workspaceId, filter: { logic: "and", children: [{ field: { kind: "attr", key: "id" }, op: "in", value: [hit.id] }] }, period: { kind: "relative", preset: "current_year" }, measures: ["budget", "actual", "spend_to_date_pct", "pace_index"], limit: 1 },
    )).body as { rows: Array<{ envelopeId: string; measures: Record<string, string | null> }> };
    const row = direct.rows.find((r) => r.envelopeId === hit.id);
    expect(row, "the direct /query call finds the same budget").toBeDefined();
    const m = row?.measures ?? {};

    // /budget search Walmart: the plain-text numbers (money(), pct() in slash/index.ts).
    const money = (v: string | null | undefined) => (v === null || v === undefined ? "—" : Number(v).toLocaleString("en", { maximumFractionDigits: 0 }));
    const pct = (v: string | null | undefined) => (v === null || v === undefined || v === "" ? "—" : `${Math.round(Number(v) * 100)}%`);
    const search = await slack("commands", { text: "search Walmart", team_id: TEAM, user_id: "U-admin" });
    const searchText = JSON.stringify(search.body);
    expect(searchText).toContain(`budget ${money(m["budget"])}, spent ${money(m["actual"])}`);
    if (m["spend_to_date_pct"] !== null && m["spend_to_date_pct"] !== undefined) expect(searchText).toContain(`(${pct(m["spend_to_date_pct"])})`);
    if (m["pace_index"] !== null && m["pace_index"] !== undefined) expect(searchText).toContain(`pace ${Number(m["pace_index"]).toFixed(2)}`);

    // /budget list Walmart: the card-formatted numbers (wholeMoney(), percent(), paceOf()).
    const list = await slack("commands", { text: "list Walmart", team_id: TEAM, user_id: "U-admin" });
    const listText = JSON.stringify(list.body);
    expect(listText).toContain(wholeMoney(m["budget"], "USD"));
    expect(listText).toContain(`spent ${percent(m["spend_to_date_pct"])}`);
    expect(listText).toContain(`pace ${paceOf(m["pace_index"])}`);
  });
});

describe("Slack acts with the app's permissions (S-001)", () => {
  it("a role that may not decide in the app is refused in Slack, even on a step for its role", async () => {
    // A policy whose only step is PLANNER, for the budget owner's changes: eligible_approver() lets a
    // planner decide it, but a planner lacks approval.decide, so the app refuses them.
    const policyId = randomUUID();
    await owner.approvalPolicy.create({ data: { id: policyId, workspaceId: golden.workspaceId, name: "Planner step (S-001 test)", priority: -1, conditions: { requester: { userIds: [golden.users.budgetOwner] } }, chain: [{ role: "PLANNER", minApprovals: 1, timeoutHours: 48 }], blockSelfApproval: true } });
    let requestId: string | null = null;
    for (const envelopeId of [...golden.envelopeIds.values()].slice(20, 60)) {
      const env = (await as("budgetOwner", "GET", `/envelopes/${envelopeId}`)).body as { current?: { id: string; amount: string } | null; draft?: unknown; status?: string };
      if (!env.current || env.draft || env.status !== "APPROVED") continue;
      const draft = await as("budgetOwner", "PATCH", `/envelopes/${envelopeId}/draft`, { amount: (Number(env.current.amount) + 1000).toFixed(2), basedOnVersionId: env.current.id });
      if (draft.status !== 200) continue;
      const sent = await as("budgetOwner", "POST", `/envelopes/${envelopeId}/submit`, { versionId: draft.body["id"] });
      if (sent.body["autoApproved"] === false) {
        requestId = String(sent.body["requestId"]);
        break;
      }
    }
    expect(requestId, "the budget owner's change waits on the planner step").not.toBeNull();
    if (!requestId) return;
    views.length = 0;
    await click("planner", "approval.approve", requestId);
    expect(JSON.stringify(views[0]?.view)).toContain("Missing permission approval.decide");
    const [n] = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM approval_decision WHERE request_id = $1::uuid`, requestId);
    expect(Number(n?.n)).toBe(0);
    expect((await as("planner", "POST", `/approvals/${requestId}/decisions`, { decision: "approve" })).status, "the app refuses the same person").toBe(403);
    await as("budgetOwner", "POST", `/approvals/${requestId}/withdraw`, {});
    await owner.approvalPolicy.update({ where: { id: policyId }, data: { isActive: false } });
  });

  it("someone with a role only in another workspace is refused here, and told so", async () => {
    const otherWs = randomUUID();
    const outsider = randomUUID();
    await owner.workspace.create({ data: { id: otherWs, orgId: golden.orgId, slug: `${slug}-other`, name: "Other client", reportingCurrency: "USD" } });
    await owner.user.create({ data: { id: outsider, orgId: golden.orgId, email: email("outsider"), name: "Outside Person", googleSub: `golden-${slug}-outsider` } });
    await owner.roleAssignment.create({ data: { id: randomUUID(), workspaceId: otherWs, principalType: "user", principalId: outsider, role: "APPROVER", createdBy: golden.users.orgAdmin } });
    const [alert] = await owner.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id::text FROM alert WHERE workspace_id = $1::uuid AND status = 'OPEN' ORDER BY opened_at LIMIT 1`, golden.workspaceId);
    expect(alert).toBeDefined();
    views.length = 0;
    await click("outsider", "alert.resolve", alert!.id);
    expect(JSON.stringify(views[0]?.view)).toContain("No role in this workspace");
    const [still] = await owner.$queryRawUnsafe<Array<{ status: string }>>(`SELECT status::text FROM alert WHERE id = $1::uuid`, alert!.id);
    expect(still?.status).toBe("OPEN");
    // R11-002: their own workspace is linked through the org, so /budget answers for it, and only it.
    const answer = JSON.stringify((await slack("commands", { text: "alerts", team_id: TEAM, user_id: "U-outsider" })).body);
    expect(answer).toContain("No open alerts");
    expect(answer).not.toContain(alert!.id);
  });

  it("finds the account when the Slack profile's email is in capitals", async () => {
    // The same Slack account as every other "admin" test here (S-14 pins by Slack user id, not
    // email): only its profile email briefly reads in capitals, as some Slack profiles do.
    slackEmailOverrides.set("U-admin", email("admin").toUpperCase());
    try {
      const res = await slack("commands", { text: "alerts", team_id: TEAM, user_id: "U-admin" });
      expect(JSON.stringify(res.body)).toMatch(/open alerts/i);
    } finally {
      slackEmailOverrides.delete("U-admin");
    }
  });
});

describe("every approval request reaches Slack (S-003)", () => {
  it("a bulk edit's request posts with Approve / Reject, and its approvers are told in the app", async () => {
    expect((await as("orgAdmin", "PATCH", "/org/integrations/slack", { link: true })).status).toBe(200);
    expect((await as("admin", "PATCH", `/workspaces/${golden.workspaceId}/integrations/slack`, { defaultChannel: "#budget" })).status).toBe(200);
    const ids: string[] = [];
    for (const envelopeId of [...golden.envelopeIds.values()].slice(60, 120)) {
      const env = (await as("planner", "GET", `/envelopes/${envelopeId}`)).body as { current?: unknown; draft?: unknown; status?: string };
      if (env.current && !env.draft && env.status === "APPROVED") ids.push(envelopeId);
      if (ids.length === 2) break;
    }
    const preview = await as("planner", "POST", "/envelopes/bulk", { workspaceId: golden.workspaceId, selection: { envelopeIds: ids }, operation: { op: "pct", pct: 20 }, rationale: "S-003 bulk request" });
    expect(preview.status, JSON.stringify(preview.body)).toBe(201);
    const committed = await as("planner", "POST", `/envelopes/bulk/${String(preview.body["previewId"])}/commit`);
    expect(committed.body, "a 20% raise waits for approval").toMatchObject({ autoApproved: false });
    const requestId = String(committed.body["requestId"]);

    // The outbox row the notify worker receives (as Pub/Sub, or the local runner, would deliver it).
    const [row] = await owner.$queryRawUnsafe<Array<{ id: string; payload: unknown }>>(`SELECT id::text, payload FROM outbox WHERE topic = 'approval.changed' AND payload->>'requestId' = $1`, requestId);
    expect(row, "the request's approval.changed row").toBeDefined();
    const push = { message: { data: Buffer.from(JSON.stringify(row!.payload)).toString("base64"), attributes: { outboxId: row!.id, workspaceId: golden.workspaceId, orgId: golden.orgId, topic: "approval.changed" }, messageId: `s003-${row!.id}` }, subscription: "notify-worker" };
    const posts: Array<{ channel: string; text: string; blocks: unknown[] }> = [];
    const slackClient: SlackClient = { postMessage: async (m) => void posts.push(m), updateMessage: async () => undefined, lookupUserByEmail: async () => null };
    await handleInApp(app, push);
    await handleSlackEvent(app, slackClient, push);
    expect(posts.map((p) => p.channel)).toEqual(["#budget"]);
    expect(posts[0]?.text).toMatch(/Approval requested/);
    expect(JSON.stringify(posts[0]?.blocks)).toContain('"action_id":"approval.approve"');
    const [told] = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM notification WHERE user_id = $1::uuid AND kind = 'approval_requested' AND payload->>'requestId' = $2`, golden.users.budgetOwner, requestId);
    expect(Number(told?.n), "the first step's approver (the budget owner)").toBe(1);
  });
});

/**
 * An open request of the planner's that the policies do not auto-approve: a 10% cut to a budget
 * with no children, so approving it can never break a parent's cap. Each budget is used once.
 */
const usedForRequests = new Set<string>();
async function openRequest(): Promise<string> {
  for (const envelopeId of [...golden.envelopeIds.values()].reverse()) {
    if (usedForRequests.has(envelopeId)) continue;
    const env = (await as("planner", "GET", `/envelopes/${envelopeId}`)).body as { current?: { id: string; amount: string } | null; draft?: unknown; status?: string; structure?: { children?: unknown[] } };
    if (!env.current || env.draft || env.status !== "APPROVED" || (env.structure?.children?.length ?? 0) > 0 || Number(env.current.amount) < 1000) continue;
    usedForRequests.add(envelopeId);
    const draft = await as("planner", "PATCH", `/envelopes/${envelopeId}/draft`, { amount: (Number(env.current.amount) * 0.9).toFixed(2), basedOnVersionId: env.current.id, rationale: "Black Friday moved to Q1" });
    if (draft.status !== 200) continue;
    const sent = await as("planner", "POST", `/envelopes/${envelopeId}/submit`, { versionId: draft.body["id"] });
    if (sent.body["autoApproved"] === false) return String(sent.body["requestId"]);
  }
  throw new Error("no budget could be sent for approval");
}

describe("Request changes from Slack (S-005)", () => {
  it("opens a form; the comment returns the request for changes and opens a blocking thread", async () => {
    const requestId = await openRequest();
    views.length = 0;
    await click("orgAdmin", "approval.changes", requestId);
    expect(views[0]?.view).toMatchObject({ callback_id: "approval.changes" });
    const submit = (comment: string) =>
      slack("interactions", { payload: JSON.stringify({ type: "view_submission", team: { id: TEAM }, user: { id: "U-orgAdmin" }, view: { callback_id: "approval.changes", private_metadata: views[0]?.view["private_metadata"], state: { values: { comment: { comment: { value: comment } } } } } }) });
    expect((await submit(" ")).body).toMatchObject({ response_action: "errors", errors: { comment: expect.stringContaining("Comment required") } });
    expect((await submit("Split it by month first")).body).toEqual({});
    const [r] = await owner.$queryRawUnsafe<Array<{ status: string }>>(`SELECT status::text FROM approval_request WHERE id = $1::uuid`, requestId);
    expect(r?.status).toBe("CHANGES_REQUESTED");
    const [d] = await owner.$queryRawUnsafe<Array<{ decision: string; channel: string; comment: string }>>(`SELECT decision::text, channel::text, comment FROM approval_decision WHERE request_id = $1::uuid`, requestId);
    expect(d).toEqual({ decision: "request_changes", channel: "slack", comment: "Split it by month first" });
    const [thread] = await owner.$queryRawUnsafe<Array<{ is_blocking: boolean }>>(`SELECT is_blocking FROM thread WHERE anchor_meta->>'approvalRequestId' = $1`, requestId);
    expect(thread?.is_blocking).toBe(true);
  });
});

describe("/budget approvals (S-006)", () => {
  const RESPONSE_URL = "https://hooks.slack.com/actions/T0GOLDEN1/1/list";
  /** A click on the private list: the value names the list, and Slack sends the list's response_url. */
  const clickOnList = (persona: string, actionId: string, id: string) =>
    slack("interactions", { payload: JSON.stringify({ type: "block_actions", team: { id: TEAM }, user: { id: `U-${persona}` }, trigger_id: `trig-${randomUUID()}`, response_url: RESPONSE_URL, container: { type: "message", is_ephemeral: true }, actions: [{ action_id: actionId, value: JSON.stringify({ ws: golden.workspaceId, id, o: "list" }) }] }) });
  const listed = (body: Record<string, unknown>) => (JSON.stringify(body["blocks"]).match(/#[0-9a-f]{8}/g) ?? []);

  it("lists what waits on the person, each with Approve / Request changes / Reject on the list", async () => {
    const requestId = await openRequest();
    const res = await slack("commands", { text: "approvals", team_id: TEAM, user_id: "U-orgAdmin" });
    expect(res.body).toMatchObject({ response_type: "ephemeral" });
    expect(listed(res.body)).toContain(shortRequestId(requestId));
    const values = (JSON.stringify(res.body["blocks"]).match(/"value":"(\{[^}]*\})"/g) ?? []).map((v) => JSON.parse(JSON.parse(v.slice(8)) as string) as { o?: string });
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((v) => v.o === "list")).toBe(true);
    // A planner decides nothing: nothing waits on them.
    expect(JSON.stringify((await slack("commands", { text: "approvals", team_id: TEAM, user_id: "U-planner" })).body)).toContain("Nothing is waiting on you");
  });

  it("Approve on the list decides, then replaces the list with what is left, led by what happened", async () => {
    const requestId = await openRequest();
    responses.length = 0;
    await clickOnList("orgAdmin", "approval.approve", requestId);
    const [d] = await owner.$queryRawUnsafe<Array<{ decision: string; channel: string }>>(`SELECT decision::text, channel::text FROM approval_decision WHERE request_id = $1::uuid`, requestId);
    expect(d).toEqual({ decision: "approve", channel: "slack" });
    expect(responses).toHaveLength(1);
    expect(responses[0]?.url).toBe(RESPONSE_URL);
    expect(responses[0]?.body).toMatchObject({ replace_original: true, response_type: "ephemeral" });
    expect(JSON.stringify(responses[0]?.body)).toContain(`:white_check_mark: Approved · ${shortRequestId(requestId)}`);
    expect(listed(responses[0]!.body).filter((x) => x === shortRequestId(requestId))).toEqual([shortRequestId(requestId)]); // only in the notice
  });

  it("Reject on the list asks for the reason, then replaces the list", async () => {
    const requestId = await openRequest();
    views.length = 0;
    responses.length = 0;
    await clickOnList("orgAdmin", "approval.reject", requestId);
    const metadata = JSON.parse(String(views[0]?.view["private_metadata"])) as { r?: string; o?: string };
    expect(metadata).toMatchObject({ o: "list", r: RESPONSE_URL });
    const submitted = await slack("interactions", { payload: JSON.stringify({ type: "view_submission", team: { id: TEAM }, user: { id: "U-orgAdmin" }, view: { callback_id: "approval.reject", private_metadata: views[0]?.view["private_metadata"], state: { values: { reason: { reason: { value: "Not this quarter" } } } } } }) });
    expect(submitted.body).toEqual({});
    expect(JSON.stringify(responses[0]?.body)).toContain(`:no_entry: Rejected · ${shortRequestId(requestId)}`);
  });

  it("when Slack refuses the response_url, the decision stands and the person is told to ask again", async () => {
    const requestId = await openRequest();
    views.length = 0;
    failNextResponse = true;
    await clickOnList("orgAdmin", "approval.approve", requestId);
    const [r] = await owner.$queryRawUnsafe<Array<{ status: string }>>(`SELECT status::text FROM approval_request WHERE id = $1::uuid`, requestId);
    expect(r?.status).toBe("APPROVED");
    expect(JSON.stringify(views[0]?.view)).toContain("could not be updated");
  });
});

describe("/budget decisions by a request's id (S-007)", () => {
  const cmd = async (persona: string, text: string) => (await slack("commands", { text, team_id: TEAM, user_id: `U-${persona}` })).body;
  const said = (body: Record<string, unknown>) => JSON.stringify(body);
  const status = async (id: string) => (await owner.$queryRawUnsafe<Array<{ status: string }>>(`SELECT status::text FROM approval_request WHERE id = $1::uuid`, id))[0]?.status;

  it("approve #id decides as the person, with the comment, and says so", async () => {
    const id = await openRequest();
    expect(said(await cmd("orgAdmin", `approve ${shortRequestId(id)} fits the plan`))).toContain(":white_check_mark: Approved");
    const [d] = await owner.$queryRawUnsafe<Array<{ decision: string; channel: string; comment: string }>>(`SELECT decision::text, channel::text, comment FROM approval_decision WHERE request_id = $1::uuid`, id);
    expect(d).toEqual({ decision: "approve", channel: "slack", comment: "fits the plan" });
    expect(await status(id)).toBe("APPROVED");
  });

  it("reject and changes ask for the reason first, then decide", async () => {
    const id = await openRequest();
    expect(said(await cmd("orgAdmin", `reject ${shortRequestId(id)}`))).toContain("Say why");
    expect(await status(id)).toBe("PENDING");
    expect(said(await cmd("orgAdmin", `reject ${shortRequestId(id)} over the Q1 cap`))).toContain(":no_entry: Rejected");
    expect(await status(id)).toBe("REJECTED");
    const other = await openRequest();
    expect(said(await cmd("orgAdmin", `changes ${shortRequestId(other)}`))).toContain("Say what should change");
    expect(said(await cmd("orgAdmin", `changes ${shortRequestId(other)} split it by month`))).toContain("Changes requested");
    expect(await status(other)).toBe("CHANGES_REQUESTED");
  });

  it("remind and withdraw are the requester's; someone else is refused, as in the app", async () => {
    const id = await openRequest();
    expect(said(await cmd("planner", `remind ${shortRequestId(id)}`))).toContain(":alarm_clock: Reminded the approvers of step 1");
    expect(said(await cmd("planner", `remind ${shortRequestId(id)}`))).toContain("less than an hour ago");
    expect(said(await cmd("budgetOwner", `withdraw ${shortRequestId(id)}`))).toContain("Only the requester or a workspace admin can withdraw");
    expect(said(await cmd("approver", `withdraw ${shortRequestId(id)}`))).toContain("Missing permission envelope.submit");
    expect(said(await cmd("planner", `withdraw ${shortRequestId(id)} not needed now`))).toContain(":wastebasket: Withdrew");
    expect(await status(id)).toBe("WITHDRAWN");
  });

  it("show #id: buttons for someone who may decide it, the reason for someone who may not", async () => {
    const id = await openRequest();
    const card = await cmd("orgAdmin", `show ${shortRequestId(id)}`);
    expect(said(card)).toContain('"action_id":"approval.approve"');
    expect(said(card)).toContain('\\"o\\":\\"card\\"');
    const own = await cmd("planner", `show ${shortRequestId(id)}`);
    expect(said(own)).not.toContain('"action_id":"approval.approve"');
    expect(said(own)).toContain("You cannot decide it: You made this change; someone else must approve it.");
  });

  it("takes a full id or a pasted link, and explains an unknown or missing one", async () => {
    const id = await openRequest();
    expect(said(await cmd("orgAdmin", `show <https://budgetos.example/w/${golden.workspaceId}/approvals/${id}|Review>`))).toContain(shortRequestId(id));
    expect(said(await cmd("orgAdmin", `show ${id}`))).toContain(shortRequestId(id));
    expect(said(await cmd("orgAdmin", "approve #00000000"))).toContain("No request #00000000 in this workspace");
    expect(said(await cmd("orgAdmin", "approve brazil"))).toContain("Which request?");
  });

  it("a card's buttons update that card", async () => {
    const id = await openRequest();
    responses.length = 0;
    await slack("interactions", { payload: JSON.stringify({ type: "block_actions", team: { id: TEAM }, user: { id: "U-orgAdmin" }, trigger_id: `trig-${randomUUID()}`, response_url: "https://hooks.slack.com/actions/T0GOLDEN1/2/card", actions: [{ action_id: "approval.approve", value: JSON.stringify({ ws: golden.workspaceId, id, o: "card" }) }] }) });
    expect(await status(id)).toBe("APPROVED");
    expect(responses[0]?.body).toMatchObject({ replace_original: true });
    expect(JSON.stringify(responses[0]?.body)).toContain(`:white_check_mark: Approved · ${shortRequestId(id)}`);
    expect(JSON.stringify(responses[0]?.body)).not.toContain('"action_id":"approval.approve"');
  });
});

describe("/budget, the summary (S-008)", () => {
  it("the year so far, what waits on the person, and their budgets", async () => {
    const res = await slack("commands", { text: "", team_id: TEAM, user_id: "U-orgAdmin" });
    expect(res.body).toMatchObject({ response_type: "ephemeral" });
    const text = JSON.stringify(res.body["blocks"]);
    expect(text).toContain("*Golden* · Golden orgAdmin");
    expect(text).toContain("This fiscal year, 1 Jan – 31 Dec 2026");
    expect(text).toContain("*Your budgets*");
    expect(text).toContain(`/w/${golden.workspaceId}/budgets?select=`);
  });

  it("someone whose scope holds no budget is told so, not given an error", async () => {
    const viewer = randomUUID();
    await owner.user.create({ data: { id: viewer, orgId: golden.orgId, email: email("scopedviewer"), name: "Scoped Viewer", googleSub: `golden-${slug}-scopedviewer` } });
    await owner.roleAssignment.create({ data: { id: randomUUID(), workspaceId: golden.workspaceId, principalType: "user", principalId: viewer, role: "VIEWER", scope: { logic: "and", children: [{ field: { kind: "dimension", key: "country" }, op: "eq", value: "ZZ" }] }, createdBy: golden.users.orgAdmin } });
    const res = await slack("commands", { text: "", team_id: TEAM, user_id: "U-scopedviewer" });
    expect(JSON.stringify(res.body)).not.toContain(":no_entry:");
    expect(JSON.stringify(res.body["blocks"])).toContain("Nothing to show yet");
  });
});

describe("/budget <name> and /budget list (S-009)", () => {
  const cmd = async (persona: string, text: string) => (await slack("commands", { text, team_id: TEAM, user_id: `U-${persona}` })).body;

  it("a budget's name gives its card: where it sits, its numbers, and a link", async () => {
    const roots = (await owner.$queryRawUnsafe<Array<{ id: string; name: string }>>(`SELECT id::text, coalesce(display_name, name) AS name FROM envelope WHERE workspace_id = $1::uuid AND parent_id IS NULL AND status <> 'ARCHIVED' ORDER BY name`, golden.workspaceId));
    const counts = new Map<string, number>();
    for (const r of roots) counts.set(r.name.toLowerCase(), (counts.get(r.name.toLowerCase()) ?? 0) + 1);
    const root = roots.find((r) => counts.get(r.name.toLowerCase()) === 1);
    expect(root, "a top-level budget with a name of its own").toBeDefined();
    const card = await cmd("planner", root!.name);
    const text = JSON.stringify(card["blocks"]);
    expect(text).toContain(`"text":"${root!.name}"`);
    expect(text).toContain("*Budget*");
    expect(text).toContain("*Pace*");
    expect(text).toContain(`/budgets?select=${root!.id}`);
    expect(String(card["text"])).toMatch(/: USD [\d,]+ budget, \d+% spent$/);
  });

  it("several matches give a choice; choosing one puts its card in place of the choice", async () => {
    const choice = await cmd("planner", "meta");
    expect(String(choice["text"])).toBe("Which “meta”?");
    const values = (JSON.stringify(choice["blocks"]).match(/"action_id":"budget.show"/g) ?? []).length;
    expect(values).toBeGreaterThan(1);
    const first = (JSON.stringify(choice["blocks"]).match(/\\"id\\":\\"([0-9a-f-]{36})\\"/) ?? [])[1];
    expect(first).toBeDefined();
    responses.length = 0;
    await slack("interactions", { payload: JSON.stringify({ type: "block_actions", team: { id: TEAM }, user: { id: "U-planner" }, trigger_id: `trig-${randomUUID()}`, response_url: "https://hooks.slack.com/actions/T0GOLDEN1/3/which", actions: [{ action_id: "budget.show", value: JSON.stringify({ ws: golden.workspaceId, id: first, o: "card" }) }] }) });
    expect(responses[0]?.body).toMatchObject({ replace_original: true, response_type: "ephemeral" });
    expect(JSON.stringify(responses[0]?.body)).toContain(`/budgets?select=${first}`);
  });

  it("says when nothing matches", async () => {
    expect(String((await cmd("planner", "zzqx nothing like it"))["text"])).toContain("Nothing matches “zzqx nothing like it”");
  });

  it("list: the top-level budgets this fiscal year; list <text>: the budgets matching it", async () => {
    const all = await cmd("orgAdmin", "list");
    expect(JSON.stringify(all["blocks"])).toContain("Top-level budgets, this fiscal year");
    expect(JSON.stringify(all["blocks"])).toMatch(/USD [\d,]+ · spent \d+% · pace [\d.—]+/);
    const some = await cmd("planner", "list meta");
    expect(JSON.stringify(some["blocks"])).toContain("Budgets matching “meta”");
  });
});

describe("which workspace /budget answers for (S-010)", () => {
  const second = randomUUID();
  const cmd = async (persona: string, text: string, channelName?: string) => (await slack("commands", { text, team_id: TEAM, user_id: `U-${persona}`, ...(channelName ? { channel_name: channelName, channel_id: "C0TESTING1" } : {}) })).body;
  const said = (body: Record<string, unknown>) => JSON.stringify(body);

  beforeAll(async () => {
    await owner.workspace.create({ data: { id: second, orgId: golden.orgId, slug: `${slug}-second`, name: "Second", reportingCurrency: "USD", settings: { slack: { teamId: TEAM, defaultChannel: "#second-budgets" } } } });
    await owner.roleAssignment.create({ data: { id: randomUUID(), workspaceId: second, principalType: "user", principalId: golden.users.planner, role: "PLANNER", createdBy: golden.users.orgAdmin } });
    // The golden workspace posts to #budget (the settings test linked it and set it).
    expect((await as("orgAdmin", "PATCH", "/org/integrations/slack", { link: true })).status).toBe(200);
    expect((await as("admin", "PATCH", `/workspaces/${golden.workspaceId}/integrations/slack`, { defaultChannel: "#budget" })).status).toBe(200);
  });

  it("a workspace's own channel answers for it", async () => {
    expect(said(await cmd("planner", "alerts", "second-budgets"))).toContain("workspace *Second*");
    expect(said(await cmd("planner", "alerts", "budget"))).toContain("workspace *Golden*");
  });

  it("elsewhere, the first by name until the person chooses; the choice is saved, audited, and a channel still wins", async () => {
    expect(said(await cmd("planner", "alerts"))).toContain("workspace *Golden* (`/budget workspace` to choose)");
    const choice = await cmd("planner", "workspace");
    expect(said(choice)).toContain("/budget answers for *Golden*, the first of yours by name.");
    expect(said(choice)).toContain('"action_id":"workspace.use"');
    expect(said(await cmd("planner", "workspace second"))).toContain("/budget answers for *Second* from now on");
    const [saved] = await owner.$queryRawUnsafe<Array<{ ws: string | null }>>(`SELECT settings->'slack'->>'defaultWorkspaceId' AS ws FROM app_user WHERE id = $1::uuid`, golden.users.planner);
    expect(saved?.ws).toBe(second);
    const [a] = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM audit_event WHERE entity_id = $1::uuid AND action = 'user.slack_settings_changed' AND workspace_id = $2::uuid`, golden.users.planner, second);
    expect(Number(a?.n)).toBe(1);
    const [o] = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE workspace_id = $1::uuid AND topic = 'user.updated' AND payload->>'userId' = $2`, second, golden.users.planner);
    expect(Number(o?.n)).toBe(1);
    expect(said(await cmd("planner", "alerts"))).toContain("workspace *Second*");
    expect(said(await cmd("planner", "workspace"))).toContain("/budget answers for *Second*, because you chose it.");
    expect(said(await cmd("planner", "alerts", "budget"))).toContain("workspace *Golden*");
  });

  it("the Use button saves the choice and says so in place of it", async () => {
    responses.length = 0;
    await slack("interactions", { payload: JSON.stringify({ type: "block_actions", team: { id: TEAM }, user: { id: "U-planner" }, trigger_id: `trig-${randomUUID()}`, response_url: "https://hooks.slack.com/actions/T0GOLDEN1/4/ws", actions: [{ action_id: "workspace.use", value: JSON.stringify({ ws: golden.workspaceId, id: golden.workspaceId }) }] }) });
    expect(JSON.stringify(responses[0]?.body)).toContain("/budget answers for *Golden* from now on");
    expect(said(await cmd("planner", "alerts"))).toContain("workspace *Golden*");
  });

  it("names only workspaces where the person holds a role", async () => {
    expect(said(await cmd("planner", "workspace other client"))).toContain("You have no role in a linked workspace called “other client”");
  });
});

describe("sending a budget for approval from Slack (S-011)", () => {
  const cmd = async (persona: string, text: string) => (await slack("commands", { text, team_id: TEAM, user_id: `U-${persona}`, trigger_id: `trig-${randomUUID()}` })).body;
  const submit = (persona: string, view: Record<string, unknown> | undefined, amount: string, why: string) =>
    slack("interactions", { payload: JSON.stringify({ type: "view_submission", team: { id: TEAM }, user: { id: `U-${persona}` }, view: { callback_id: "budget.request", private_metadata: view?.["private_metadata"], state: { values: { amount: { amount: { value: amount } }, why: { why: { value: why } } } } } }) });
  /** Budgets with a name of their own, no children, approved, nothing pending: one per test. */
  let spare: Array<{ id: string; name: string; amount: string; current: string }> = [];
  const take = () => spare.shift() ?? (() => { throw new Error("no spare budget"); })();

  beforeAll(async () => {
    spare = await owner.$queryRawUnsafe<Array<{ id: string; name: string; amount: string; current: string }>>(
      `SELECT e.id::text, e.name, v.amount::text AS amount, v.id::text AS current FROM envelope e JOIN envelope_version v ON v.id = e.current_version_id
        WHERE e.workspace_id = $1::uuid AND e.status = 'APPROVED' AND e.draft_version_id IS NULL AND e.display_name IS NULL AND v.amount >= 5000
          AND NOT EXISTS (SELECT 1 FROM envelope c WHERE c.parent_id = e.id AND c.status <> 'ARCHIVED')
          AND (SELECT count(*) FROM envelope o WHERE o.workspace_id = e.workspace_id AND lower(o.name) = lower(e.name)) = 1
        ORDER BY e.name LIMIT 10`,
      golden.workspaceId,
    );
    spare = spare.filter((s) => !usedForRequests.has(s.id));
  });

  it("/budget request <name> opens the form with what the budget holds now; the form refuses a guessed amount and a missing reason", async () => {
    const b = take();
    views.length = 0;
    expect(await cmd("planner", `request ${b.name}`)).toEqual({});
    const form = views[0]?.view;
    expect(form).toMatchObject({ callback_id: "budget.request" });
    expect(JSON.parse(String(form?.["private_metadata"]))).toEqual({ ws: golden.workspaceId, id: b.id, base: b.current });
    expect(JSON.stringify(form)).toContain("approved");
    expect((await submit("planner", form, "12k", "")).body).toEqual({ response_action: "errors", errors: { amount: expect.stringContaining("like 120000"), why: "Say why, in a few words" } });
  });

  it("sending it drafts and submits in one step, with both audit and outbox pairs; the worker posts it and tells the approver", async () => {
    const b = take();
    views.length = 0;
    await cmd("planner", `request ${b.name}`);
    const amount = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.round(Number(b.amount) * 90) / 100);
    const since = new Date();
    const sent = await submit("planner", views[0]?.view, amount, "Q1 moves to Q2");
    expect(sent.body).toMatchObject({ response_action: "update" });
    expect(JSON.stringify(sent.body)).toMatch(/Sent for approval\* as #[0-9a-f]{8}/);
    const [r] = await owner.$queryRawUnsafe<Array<{ id: string; status: string; requested_by: string }>>(`SELECT r.id::text, r.status::text, r.requested_by::text FROM approval_request r JOIN envelope_version v ON v.id = r.entity_id WHERE v.envelope_id = $1::uuid ORDER BY r.requested_at DESC LIMIT 1`, b.id);
    expect(r).toMatchObject({ status: "PENDING", requested_by: golden.users.planner });
    const audits = await owner.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_event WHERE occurred_at >= $3 AND ((entity_id = $1::uuid AND action = 'envelope.version.created') OR (entity_id = $2::uuid AND action = 'approval.requested')) ORDER BY occurred_at`, b.id, r!.id, since);
    // One transaction, one timestamp: compared as a set.
    expect(audits.map((a) => a.action).sort()).toEqual(["approval.requested", "envelope.version.created"]);
    const [changed] = await owner.$queryRawUnsafe<Array<{ id: string; payload: unknown }>>(`SELECT id::text, payload FROM outbox WHERE topic = 'approval.changed' AND payload->>'requestId' = $1`, r!.id);
    expect(changed).toBeDefined();
    const posts: Array<{ channel: string }> = [];
    const client: SlackClient = { postMessage: async (m) => (posts.push(m), { channel: m.channel.startsWith("#") ? "C0BUDGET1" : m.channel, ts: `${Date.now()}.1` }), updateMessage: async () => undefined, lookupUserByEmail: async (e) => `U-${e.split("@")[0]}`, openDm: async (u) => `D-${u}` };
    const push = { message: { data: Buffer.from(JSON.stringify(changed!.payload)).toString("base64"), attributes: { outboxId: changed!.id, workspaceId: golden.workspaceId, orgId: golden.orgId, topic: "approval.changed" }, messageId: `s011-${changed!.id}` }, subscription: "notify-worker" };
    await handleSlackEvent(app, client, push);
    expect(posts.map((p) => p.channel)).toContain("#budget");
    expect(posts.map((p) => p.channel)).toContain("D-U-budgetowner");
  });

  it("an admin's own change applies at once; the parent's cap still holds", async () => {
    const b = take();
    views.length = 0;
    await cmd("admin", `request ${b.name}`);
    // A raise past what the parent holds is refused in the form, as in the app.
    expect(JSON.stringify((await submit("admin", views[0]?.view, (Number(b.amount) * 10).toFixed(2), "Doubling down")).body)).toContain("Children exceed parent budget");
    const target = (Math.round(Number(b.amount) * 95) / 100).toFixed(2);
    const applied = await submit("admin", views[0]?.view, target, "Savings agreed in the QBR");
    expect(JSON.stringify(applied.body)).toContain("*Applied.*");
    const [e] = await owner.$queryRawUnsafe<Array<{ amount: string }>>(`SELECT v.amount::text AS amount FROM envelope e JOIN envelope_version v ON v.id = e.current_version_id WHERE e.id = $1::uuid`, b.id);
    expect(e?.amount).toBe(target);
  });

  it("a budget that changed after the form opened is refused, as in the app", async () => {
    const b = take();
    views.length = 0;
    await cmd("planner", `request ${b.name}`);
    const form = views[0]?.view;
    expect((await as("planner", "PATCH", `/envelopes/${b.id}/draft`, { amount: (Number(b.amount) * 0.97).toFixed(2), basedOnVersionId: b.current })).status).toBe(200);
    expect((await submit("planner", form, (Number(b.amount) * 0.9).toFixed(2), "Changed my mind")).body).toEqual({ response_action: "errors", errors: { amount: "Envelope changed since you loaded it" } });
  });

  it("a budget already waiting is refused before the form opens; the card offers Request a change only to someone who may send one", async () => {
    const b = take();
    views.length = 0;
    await cmd("planner", `request ${b.name}`);
    await submit("planner", views[0]?.view, (Number(b.amount) * 0.8).toFixed(2), "Moved to another market");
    expect(JSON.stringify(await cmd("planner", `request ${b.name}`))).toMatch(/already waiting \(#[0-9a-f]{8}\)/);
    const other = take();
    expect(JSON.stringify((await cmd("planner", other.name))["blocks"])).toContain('"action_id":"budget.request"');
    expect(JSON.stringify((await cmd("approver", other.name))["blocks"])).not.toContain('"action_id":"budget.request"');
  });
});

describe("answers slower than Slack waits (S-012)", () => {
  it("says it is working on it, then sends the answer through the command's response_url", async () => {
    // "U-SLOW-<x>" is a distinct Slack user id from "U-<x>" (S-012's fake answers slowly by id
    // prefix): a dedicated persona avoids colliding with "planner"'s own pin (S-14) from "U-planner".
    const slowId = randomUUID();
    await owner.user.create({ data: { id: slowId, orgId: golden.orgId, email: email("slowpoke"), name: "Slow Poke", googleSub: `golden-${slug}-slowpoke` } });
    await owner.roleAssignment.create({ data: { id: randomUUID(), workspaceId: golden.workspaceId, principalType: "user", principalId: slowId, role: "VIEWER", createdBy: golden.users.orgAdmin } });
    setCommandDeadline(50);
    try {
      responses.length = 0;
      const url = "https://hooks.slack.com/commands/T0GOLDEN1/5/late";
      const first = await slack("commands", { text: "alerts", team_id: TEAM, user_id: "U-SLOW-slowpoke", response_url: url });
      expect(first.body).toEqual({ response_type: "ephemeral", text: ":hourglass_flowing_sand: Working on it…" });
      for (let i = 0; i < 100 && !responses.some((r) => r.url === url); i += 1) await new Promise((r) => setTimeout(r, 50));
      const late = responses.find((r) => r.url === url);
      expect(late?.body).toMatchObject({ replace_original: true, response_type: "ephemeral" });
      expect(JSON.stringify(late?.body)).toMatch(/open alerts/i);
    } finally {
      setCommandDeadline(undefined);
    }
  });

  it("a quick answer comes at once", async () => {
    expect(String((await slack("commands", { text: "help", team_id: TEAM, user_id: "U-planner", response_url: "https://hooks.slack.com/commands/T0GOLDEN1/6/quick" })).body["text"])).toContain("/budget approvals");
  });
});

describe("Slack identity is pinned to the app user (S-14)", () => {
  // Fresh app users, so each test's "first contact" is really first: the personas above have
  // already been pinned by earlier tests in this file.
  async function freshPerson(label: string): Promise<{ id: string; email: string }> {
    const id = randomUUID();
    const personEmail = email(label);
    await owner.user.create({ data: { id, orgId: golden.orgId, email: personEmail, name: `Pin ${label}` } });
    await owner.roleAssignment.create({ data: { id: randomUUID(), workspaceId: golden.workspaceId, principalType: "user", principalId: id, role: "VIEWER", createdBy: golden.users.orgAdmin } });
    return { id, email: personEmail };
  }
  const pinnedSlackId = async (id: string) => (await owner.$queryRawUnsafe<Array<{ slack_user_id: string | null }>>(`SELECT slack_user_id FROM app_user WHERE id = $1::uuid`, id))[0]?.slack_user_id ?? null;
  const linkCount = async (id: string, action: "person.slack_linked" | "person.slack_unlinked") => Number((await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM audit_event WHERE entity_id = $1::uuid AND action = $2 AND workspace_id IS NULL`, id, action))[0]?.n ?? 0);

  it("first contact links the Slack account to the app user, and audits it at the org level", async () => {
    const who = await freshPerson(`pin-first-${randomUUID().slice(0, 6)}`);
    expect(await pinnedSlackId(who.id)).toBeNull();
    const res = await slack("commands", { text: "alerts", team_id: TEAM, user_id: "U-pin-first-1" });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/not the one linked to/);
    expect(await pinnedSlackId(who.id)).toBeNull(); // U-pin-first-1 resolves to its own convention email, not `who`
    // Point U-pin-first-1 at `who`'s email instead, as `users.info` would after a profile edit.
    slackEmailOverrides.set("U-pin-first-2", who.email);
    const linked = await slack("commands", { text: "alerts", team_id: TEAM, user_id: "U-pin-first-2" });
    expect(linked.status).toBe(200);
    expect(await pinnedSlackId(who.id)).toBe("U-pin-first-2");
    expect(await linkCount(who.id, "person.slack_linked")).toBe(1);
    // Asking again with the same Slack account changes nothing and writes no second audit row.
    await slack("commands", { text: "alerts", team_id: TEAM, user_id: "U-pin-first-2" });
    expect(await linkCount(who.id, "person.slack_linked")).toBe(1);
  });

  it("a second Slack account for the same email is refused, not silently re-pinned", async () => {
    const who = await freshPerson(`pin-second-${randomUUID().slice(0, 6)}`);
    slackEmailOverrides.set("U-pin-second-a", who.email);
    await slack("commands", { text: "alerts", team_id: TEAM, user_id: "U-pin-second-a" });
    expect(await pinnedSlackId(who.id)).toBe("U-pin-second-a");
    slackEmailOverrides.set("U-pin-second-b", who.email);
    const impostor = await slack("commands", { text: "alerts", team_id: TEAM, user_id: "U-pin-second-b" });
    expect(impostor.status).toBe(200); // the command still answers (ephemeral refusal), not a 4xx
    expect(String(impostor.body["text"])).toContain(`not the one linked to ${who.email}`);
    expect(String(impostor.body["text"])).toContain("ask an org admin to relink");
    expect(await pinnedSlackId(who.id)).toBe("U-pin-second-a"); // unchanged
    expect(await linkCount(who.id, "person.slack_linked")).toBe(1);
  });

  it("a Slack account already pinned to someone is refused for a different email, not re-pinned to them", async () => {
    const first = await freshPerson(`pin-shared-a-${randomUUID().slice(0, 6)}`);
    const second = await freshPerson(`pin-shared-b-${randomUUID().slice(0, 6)}`);
    slackEmailOverrides.set("U-pin-shared", first.email);
    await slack("commands", { text: "alerts", team_id: TEAM, user_id: "U-pin-shared" });
    expect(await pinnedSlackId(first.id)).toBe("U-pin-shared");
    slackEmailOverrides.set("U-pin-shared", second.email); // the same Slack account, now claiming to be `second`
    const res = await slack("commands", { text: "alerts", team_id: TEAM, user_id: "U-pin-shared" });
    expect(String(res.body["text"])).toContain(`not the one linked to ${second.email}`);
    expect(await pinnedSlackId(second.id)).toBeNull();
    expect(await linkCount(second.id, "person.slack_linked")).toBe(0);
  });

  it("an org admin relinks a person: unlink, then the next Slack account re-pins", async () => {
    const who = await freshPerson(`pin-relink-${randomUUID().slice(0, 6)}`);
    slackEmailOverrides.set("U-pin-relink-old", who.email);
    await slack("commands", { text: "alerts", team_id: TEAM, user_id: "U-pin-relink-old" });
    expect(await pinnedSlackId(who.id)).toBe("U-pin-relink-old");
    expect((await as("planner", "PATCH", `/org/people/${who.id}`, { slackUserId: null })).status).toBe(403);
    const unlinked = await as("orgAdmin", "PATCH", `/org/people/${who.id}`, { slackUserId: null });
    expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(200);
    expect(unlinked.body).toMatchObject({ slackUserId: null, changed: true });
    expect(await pinnedSlackId(who.id)).toBeNull();
    expect(await linkCount(who.id, "person.slack_unlinked")).toBe(1);
    // Their new Slack account (still claiming the same email the impostor test above used) now
    // links cleanly: the pin was cleared, so this is first contact again.
    slackEmailOverrides.set("U-pin-relink-new", who.email);
    const relinked = await slack("commands", { text: "alerts", team_id: TEAM, user_id: "U-pin-relink-new" });
    expect(String(relinked.body["text"])).not.toMatch(/not the one linked to/);
    expect(await pinnedSlackId(who.id)).toBe("U-pin-relink-new");
    // One link row for the original pin, one for the relink.
    expect(await linkCount(who.id, "person.slack_linked")).toBe(2);
  });
});

describe("Slack signature replay cache (S-15)", () => {
  beforeAll(() => resetSlackReplayCache());

  it("refuses a replayed signed request", async () => {
    const fields = { text: "help", team_id: TEAM, user_id: "U-planner-replay" };
    const timestamp = Math.floor(Date.now() / 1000);
    const first = await slack("commands", fields, { timestamp });
    expect(first.status).toBe(200);
    const replay = await slack("commands", fields, { timestamp });
    expect(replay.status).toBe(401);
    expect(replay.body).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("still accepts a Slack retry of a request that timed out", async () => {
    const fields = { text: "help", team_id: TEAM, user_id: "U-planner-retry" };
    const timestamp = Math.floor(Date.now() / 1000);
    const first = await slack("commands", fields, { timestamp });
    expect(first.status).toBe(200);
    // Slack's own retry carries the same signature (same timestamp, same body) plus these headers.
    const retried = await slack("commands", fields, { timestamp, headers: { "x-slack-retry-num": "1", "x-slack-retry-reason": "http_timeout" } });
    expect(retried.status).toBe(200);
    // A plain replay (no retry headers) of that same signed request is still refused.
    expect((await slack("commands", fields, { timestamp })).status).toBe(401);
  });
});

