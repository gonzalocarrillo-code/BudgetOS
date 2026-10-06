import { randomUUID } from "node:crypto";
import { withTenant, type TenantContext } from "@budget/db";
import { deleteWorkspaceForTests, idempotencySweep } from "@budget/workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appDb, ownerDb, startHarness, testUser, type Harness, type TestUser } from "../test-support/harness.js";
import { resetSlackReplayCache, signSlackBody } from "../modules/slack/signature.js";
import { setSlackApi, type SlackApi } from "../modules/slack/slack-api.js";

/**
 * W3-2 (audit I-6, spec §17, ADR-0081): every mutating route accepts `Idempotency-Key`. The same
 * key from the same person in the same workspace replays the first response instead of running the
 * write again; a failed attempt does not burn the key; concurrent duplicates run once; another
 * person's identical key is their own; the stored rows are RLS-isolated; Slack's own retries replay;
 * the worker's daily sweep removes rows past 24 h.
 */

const owner = ownerDb();
const app = appDb();
let h: Harness;
const orgId = randomUUID();
const ws = randomUUID();
const otherWs = randomUUID();
const planner = testUser("w32-planner", randomUUID());
const planner2 = testUser("w32-planner2", randomUUID());
const orgAdmin = testUser("w32-org", randomUUID());
const SECRET = "w32-signing-secret";
const TEAM = "T-W32";

type Res = { status: number; body: Record<string, unknown>; headers: Record<string, unknown> };
async function call(user: TestUser, method: "GET" | "POST" | "PATCH", url: string, body: unknown, key?: string): Promise<Res> {
  return h.call(method, `/api/v1${url}`, await h.mint(user), { headers: { "x-workspace-id": ws, ...(key === undefined ? {} : { "idempotency-key": key }) }, body });
}
const envelopeBody = (name: string, ownerId: string = planner.id) => ({ name, dimensionValues: { region: "br" }, startDate: "2026-01-01", endDate: "2026-12-31", currency: "USD", amount: "500.00", ownerId });
const create = (user: TestUser, body: unknown, key?: string) => call(user, "POST", `/workspaces/${ws}/envelopes`, body, key);
const countByName = async (name: string) => Number((await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM envelope WHERE workspace_id = $1::uuid AND name = $2`, ws, name))[0]?.n);
const keyRows = async (key: string) => owner.$queryRawUnsafe<Array<{ actor_id: string | null; status: number | null; completed: boolean }>>(`SELECT actor_id::text, status, completed_at IS NOT NULL AS completed FROM idempotency_key WHERE key = $1`, key);
const ctx = (over: Partial<TenantContext>): TenantContext => ({ workspaceId: ws, orgId, userId: planner.id, isOrgAdmin: false, actorType: "user", requestId: `w32-${randomUUID()}`, ...over });

let userEmailCalls = 0;
const fakeSlack: SlackApi = {
  userEmail: async () => {
    userEmailCalls += 1;
    return null;
  },
  openView: async () => undefined,
  team: async () => ({ id: TEAM, name: "W32 Slack" }),
};

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "w32" } });
  await owner.workspace.createMany({
    data: [
      { id: ws, orgId, slug: `w32-${ws}`, name: "W3-2", reportingCurrency: "USD", fiscalYearStartMonth: 1 },
      { id: otherWs, orgId, slug: `w32-${otherWs}`, name: "W3-2 other", reportingCurrency: "USD", fiscalYearStartMonth: 1 },
    ],
  });
  await owner.user.createMany({ data: [planner, planner2, orgAdmin].map((u) => ({ id: u.id, orgId, email: u.email, name: u.sub, googleSub: `g-${u.sub}` })) });
  await owner.roleAssignment.createMany({
    data: [
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: planner.id, role: "PLANNER", createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: planner2.id, role: "PLANNER", createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: otherWs, principalType: "user", principalId: planner.id, role: "PLANNER", createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: null, principalType: "user", principalId: orgAdmin.id, role: "ORG_ADMIN", createdBy: orgAdmin.id },
    ],
  });
  const region = randomUUID();
  await owner.$executeRawUnsafe(`INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by) VALUES ($1::uuid, $2::uuid, NULL, 'region', 'Region', 'ENUM', $3::uuid)`, region, orgId, orgAdmin.id);
  await owner.$executeRawUnsafe(`INSERT INTO dimension_value (id, dimension_id, code, label) VALUES ($1::uuid, $2::uuid, 'br', 'Brazil')`, randomUUID(), region);
  process.env["SLACK_SIGNING_SECRET"] = SECRET;
  setSlackApi(fakeSlack);
  h = await startHarness();
}, 60_000);

afterAll(async () => {
  await h?.close();
  setSlackApi(undefined);
  // idempotency_key.workspace_id is ON DELETE CASCADE, so it needs no explicit cleanup here.
  // W3-11 (audit I-32): deletes every row that FKs to these workspaces (and the workspace rows
  // themselves), in the same order `purgeWorkspace` validates against production.
  await deleteWorkspaceForTests(owner, [ws, otherWs]);
  await owner.$executeRawUnsafe(`DELETE FROM idempotency_key WHERE org_id = $1::uuid OR slack_team_id = $2`, orgId, TEAM);
  await owner.$executeRawUnsafe(`DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`, orgId);
  await owner.$executeRawUnsafe(`DELETE FROM dimension WHERE org_id = $1::uuid`, orgId);
  await owner.roleAssignment.deleteMany({ where: { principalId: orgAdmin.id } });
  await owner.user.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("Idempotency-Key", () => {
  it("two identical POSTs with the same key create one envelope and answer with the same status and body", async () => {
    const key = randomUUID();
    const body = envelopeBody(`Twice ${key}`);
    const first = await create(planner, body, key);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await create(planner, body, key);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    expect(await countByName(body.name)).toBe(1);
    expect(await keyRows(key)).toEqual([{ actor_id: planner.id, status: 201, completed: true }]);
  });

  it("without a key, behaves exactly as before: two POSTs, two envelopes", async () => {
    const body = envelopeBody(`No key ${randomUUID()}`);
    expect((await create(planner, body)).status).toBe(201);
    expect((await create(planner, body)).status).toBe(201);
    expect(await countByName(body.name)).toBe(2);
  });

  it("a failed attempt does not burn the key: the next call with the same key runs", async () => {
    const key = randomUUID();
    // Refused by validation (422) and released.
    const invalid = await create(planner, { ...envelopeBody(`Invalid ${key}`), startDate: "2026-12-31", endDate: "2026-01-01" }, key);
    expect(invalid.status).toBe(422);
    expect(await keyRows(key)).toEqual([]);
    // Refused by the command itself (an owner that does not exist yet) and released.
    const lateOwner = randomUUID();
    const body = envelopeBody(`Late owner ${key}`, lateOwner);
    const refused = await create(planner, body, key);
    expect(refused.status, JSON.stringify(refused.body)).toBe(404);
    expect(await keyRows(key)).toEqual([]);
    await owner.user.create({ data: { id: lateOwner, orgId, email: `late-${lateOwner}@planner.test`, name: "Late owner", googleSub: `g-late-${lateOwner}` } });
    const retried = await create(planner, body, key);
    expect(retried.status, JSON.stringify(retried.body)).toBe(201);
    expect(retried.headers["idempotent-replayed"]).toBeUndefined();
    expect(await countByName(body.name)).toBe(1);
  });

  it("concurrent duplicates: one executes, the other replays the same body", async () => {
    const key = randomUUID();
    const body = envelopeBody(`Concurrent ${key}`);
    const [a, b] = await Promise.all([create(planner, body, key), create(planner, body, key)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body).toEqual(b.body);
    expect([a.headers["idempotent-replayed"], b.headers["idempotent-replayed"]].filter((v) => v === "true")).toHaveLength(1);
    expect(await countByName(body.name)).toBe(1);
  });

  it("the same key reused for a different request is refused", async () => {
    const key = randomUUID();
    expect((await create(planner, envelopeBody(`First ${key}`), key)).status).toBe(201);
    const other = await create(planner, envelopeBody(`Second ${key}`), key);
    expect(other.status).toBe(422);
    expect(other.body).toMatchObject({ code: "VALIDATION" });
    expect(await countByName(`Second ${key}`)).toBe(0);
  });

  it("another person's identical key is independent", async () => {
    const key = randomUUID();
    const body = envelopeBody(`Two people ${key}`);
    const mine = await create(planner, body, key);
    const theirs = await create(planner2, body, key);
    expect([mine.status, theirs.status]).toEqual([201, 201]);
    expect(theirs.headers["idempotent-replayed"]).toBeUndefined();
    expect(theirs.body["id"]).not.toEqual(mine.body["id"]);
    expect(await countByName(body.name)).toBe(2);
  });

  it("the stored row is RLS-isolated to its workspace and person", async () => {
    const key = randomUUID();
    expect((await create(planner, envelopeBody(`Isolated ${key}`), key)).status).toBe(201);
    const visible = (c: TenantContext) => withTenant(app, c, async (tx) => Number((await tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM idempotency_key WHERE key = $1`, key))[0]?.n));
    expect(await visible(ctx({}))).toBe(1);
    expect(await visible(ctx({ userId: planner2.id }))).toBe(0);
    expect(await visible(ctx({ workspaceId: otherWs }))).toBe(0);
    expect(await visible(ctx({ workspaceId: null }))).toBe(0);
    // The same key in another workspace is a separate request.
    const elsewhere = await h.call("POST", `/api/v1/workspaces/${otherWs}/envelopes`, await h.mint(planner), { headers: { "idempotency-key": key }, body: envelopeBody(`Isolated ${key}`) });
    expect(elsewhere.status, JSON.stringify(elsewhere.body)).toBe(201);
    expect(elsewhere.headers["idempotent-replayed"]).toBeUndefined();
  });

  it("a key that is not a short printable token is refused", async () => {
    expect((await create(planner, envelopeBody(`Bad key ${randomUUID()}`), "x".repeat(300))).status).toBe(422);
  });

  it("Slack's own retry of a request replays the first answer instead of running it again", async () => {
    resetSlackReplayCache();
    const raw = new URLSearchParams({ command: "/budget", text: "alerts", team_id: TEAM, user_id: "U-W32", trigger_id: `trig-${randomUUID()}` }).toString();
    const timestamp = Math.floor(Date.now() / 1000);
    const send = (headers: Record<string, string> = {}) =>
      h.app.getHttpAdapter().getInstance().inject({ method: "POST", url: "/api/v1/slack/commands", headers: { "content-type": "application/x-www-form-urlencoded", ...signSlackBody(SECRET, raw, timestamp), ...headers }, payload: raw });
    const before = userEmailCalls;
    const first = await send();
    expect(first.statusCode, first.body).toBe(200);
    expect(userEmailCalls).toBe(before + 1);
    const retry = await send({ "x-slack-retry-num": "1", "x-slack-retry-reason": "http_timeout" });
    expect(retry.statusCode).toBe(200);
    expect(retry.body).toBe(first.body);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(userEmailCalls, "the command did not run a second time").toBe(before + 1);
  });

  it("the worker's daily sweep removes rows older than 24 h and keeps the rest", async () => {
    const fresh = randomUUID();
    const stale = randomUUID();
    expect((await create(planner, envelopeBody(`Fresh ${fresh}`), fresh)).status).toBe(201);
    expect((await create(planner, envelopeBody(`Stale ${stale}`), stale)).status).toBe(201);
    await owner.$executeRawUnsafe(`UPDATE idempotency_key SET created_at = now() - interval '25 hours' WHERE key = $1`, stale);
    const removed = await idempotencySweep(app, [orgId]);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await keyRows(stale)).toEqual([]);
    expect(await keyRows(fresh)).toHaveLength(1);
  });

  it("a stale key is not replayed even before the sweep runs", async () => {
    const key = randomUUID();
    const body = envelopeBody(`Expired ${key}`);
    expect((await create(planner, body, key)).status).toBe(201);
    await owner.$executeRawUnsafe(`UPDATE idempotency_key SET created_at = now() - interval '25 hours' WHERE key = $1`, key);
    const again = await create(planner, body, key);
    expect(again.status).toBe(201);
    expect(again.headers["idempotent-replayed"]).toBeUndefined();
    expect(await countByName(body.name)).toBe(2);
  });
});
