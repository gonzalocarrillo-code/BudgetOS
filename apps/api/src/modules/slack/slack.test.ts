import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGolden, type GoldenResult } from "../../seed/golden.js";
import { cleanupGolden } from "../../test-support/golden-cleanup.js";
import { appDb, ownerDb, startHarness, type Harness } from "../../test-support/harness.js";
import { signSlackBody } from "./signature.js";
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

beforeAll(async () => {
  process.env["SLACK_SIGNING_SECRET"] = SECRET;
  setSlackApi(fake);
  golden = await seedGolden(app, owner, { slug });
  h = await startHarness();
}, 180_000);

afterAll(async () => {
  setSlackApi(undefined);
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
    expect(set.body).toMatchObject({ teamId: TEAM, teamName: "Golden Slack", defaultChannel: "#budget", alertChannel: "#alerts", alertSeverities: ["warning", "critical"] });
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
    expect(views.map((v) => JSON.stringify(v.view))).toEqual([expect.stringContaining("not linked"), expect.stringContaining("No active Budget OS account")]);
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
    expect(JSON.stringify(budget.body)).toMatch(/budget [\d,]+/);
    const nobody = await slack("commands", { text: "alerts", team_id: TEAM, user_id: "U-stranger" });
    expect(String(nobody.body["text"])).toContain("No Budget OS workspace");
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
    expect(String((await slack("commands", { text: "alerts", team_id: TEAM, user_id: "U-outsider" })).body["text"])).toContain("No Budget OS workspace");
  });

  it("finds the account when the Slack profile's email is in capitals", async () => {
    const res = await slack("commands", { text: "alerts", team_id: TEAM, user_id: "U-CAPS-admin" });
    expect(JSON.stringify(res.body)).toMatch(/open alerts/i);
  });
});
