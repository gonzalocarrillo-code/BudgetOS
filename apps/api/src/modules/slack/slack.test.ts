import { randomUUID } from "node:crypto";
import { shortRequestId } from "@budget/domain";
import { handleInApp, handleSlackEvent, type SlackClient } from "@budget/workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGolden, type GoldenResult } from "../../seed/golden.js";
import { cleanupGolden } from "../../test-support/golden-cleanup.js";
import { appDb, ownerDb, startHarness, type Harness } from "../../test-support/harness.js";
import { signSlackBody } from "./signature.js";
import { setSlackResponder } from "./respond.js";
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
const fake: SlackApi = {
  // "U-<persona>" is that persona; "U-CAPS-<persona>" has the same email in capitals, as some Slack profiles do.
  userEmail: async (slackUserId) => (slackUserId.startsWith("U-CAPS-") ? email(slackUserId.slice(7)).toUpperCase() : slackUserId.startsWith("U-") ? email(slackUserId.slice(2)) : null),
  openView: async (trigger, view) => void views.push({ trigger, view }),
  team: async () => ({ id: TEAM, name: "Golden Slack" }),
};

async function as(persona: string, method: "GET" | "POST" | "PATCH", url: string, body?: unknown) {
  const token = await h.mint({ sub: `ip-${persona}`, email: email(persona) }, { googleSub: `golden-${slug}-${persona}` });
  return h.call(method, `/api/v1${url}`, token, { headers: { "x-workspace-id": golden.workspaceId }, ...(body === undefined ? {} : { body }) });
}
/** What Slack sends: a form body, signed. */
async function slack(path: "interactions" | "commands", fields: Record<string, string>, opts: { secret?: string; timestamp?: number } = {}) {
  const raw = new URLSearchParams(fields).toString();
  const res = await h.app.getHttpAdapter().getInstance().inject({ method: "POST", url: `/api/v1/slack/${path}`, headers: { "content-type": "application/x-www-form-urlencoded", ...signSlackBody(opts.secret ?? SECRET, raw, opts.timestamp) }, payload: raw });
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
  it("members read them; admins set channels and link the Slack team (audited)", async () => {
    const read = await as("planner", "GET", `/workspaces/${golden.workspaceId}/integrations/slack`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ connected: { signingSecret: true }, urls: { interactions: expect.stringMatching(/\/api\/v1\/slack\/interactions$/) } });
    expect((await as("planner", "PATCH", `/workspaces/${golden.workspaceId}/integrations/slack`, { defaultChannel: "#budget" })).status).toBe(403);
    const set = await as("admin", "PATCH", `/workspaces/${golden.workspaceId}/integrations/slack`, { defaultChannel: "#budget", alertChannel: "#alerts", alertSeverities: ["warning", "critical"], link: true });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toMatchObject({ teamId: TEAM, teamName: "Golden Slack", defaultChannel: "#budget", alertChannel: "#alerts", alertSeverities: ["warning", "critical"], dms: true });
    // S-004: direct messages to approvers and requesters can be turned off, and back on.
    expect((await as("admin", "PATCH", `/workspaces/${golden.workspaceId}/integrations/slack`, { dms: false })).body).toMatchObject({ dms: false, defaultChannel: "#budget" });
    expect(((await as("planner", "GET", `/workspaces/${golden.workspaceId}/integrations/slack`)).body["settings"] as { dms: boolean }).dms).toBe(false);
    expect((await as("admin", "PATCH", `/workspaces/${golden.workspaceId}/integrations/slack`, { dms: true })).body).toMatchObject({ dms: true });
    const test = await as("admin", "POST", `/workspaces/${golden.workspaceId}/integrations/slack/test`, {});
    expect(test.body).toMatchObject({ queued: true, channel: "#budget" });
    const [q] = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE workspace_id = $1::uuid AND topic = 'slack.test'`, golden.workspaceId);
    expect(Number(q?.n)).toBe(1);
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
    // /budget shows them nothing of this workspace either.
    expect(String((await slack("commands", { text: "alerts", team_id: TEAM, user_id: "U-outsider" })).body["text"])).toContain("No BudgetOS workspace");
  });

  it("finds the account when the Slack profile's email is in capitals", async () => {
    const res = await slack("commands", { text: "alerts", team_id: TEAM, user_id: "U-CAPS-admin" });
    expect(JSON.stringify(res.body)).toMatch(/open alerts/i);
  });
});

describe("every approval request reaches Slack (S-003)", () => {
  it("a bulk edit's request posts with Approve / Reject, and its approvers are told in the app", async () => {
    expect((await as("admin", "PATCH", `/workspaces/${golden.workspaceId}/integrations/slack`, { defaultChannel: "#budget", link: true })).status).toBe(200);
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
    expect((await as("admin", "PATCH", `/workspaces/${golden.workspaceId}/integrations/slack`, { defaultChannel: "#budget", link: true })).status).toBe(200);
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

