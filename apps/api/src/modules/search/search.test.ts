import { randomUUID } from "node:crypto";
import { handleSearchEvent, reindexWorkspace } from "@budget/workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appDb, ownerDb, startHarness, testUser, type Harness, type TestUser } from "../../test-support/harness.js";

/**
 * T-020 (spec §12): documents are built by the indexer from real outbox rows (fed as Pub/Sub
 * pushes), search applies the caller's dimension scope, and suggest reads the registry live, so a
 * new dimension is a qualifier at once (Epic 0.4). Index lag on the golden seed: seed/golden.test.ts.
 */

const owner = ownerDb();
const app = appDb();
let h: Harness;
const orgId = randomUUID();
const ws = randomUUID();
const planner = testUser("t020-planner", randomUUID());
const scoped = testUser("t020-scoped", randomUUID());
const admin = testUser("t020-admin", randomUUID());
const orgAdmin = testUser("t020-org", randomUUID());
const X = { "x-workspace-id": ws };
const env: Record<string, string> = {};
let delivered = "0";

type Res = { status: number; body: Record<string, unknown> };
async function call(user: TestUser, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<Res> {
  return h.call(method, `/api/v1${url}`, await h.mint(user), { headers: X, ...(body === undefined ? {} : { body }) });
}
type Groups = Array<{ type: string; count: number; hits: Array<{ id: string; title: string; path: string; deepLink: string }> }>;
const search = async (user: TestUser, q: string) => {
  const res = await call(user, "GET", `/workspaces/${ws}/search?q=${encodeURIComponent(q)}&limit=20`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body["groups"] as Groups;
};
const titles = (groups: Groups, type: string) => (groups.find((g) => g.type === type)?.hits ?? []).map((h) => h.title).sort();

/** Pushes every outbox row of the workspace not yet delivered to the search indexer, in order. */
async function index(): Promise<void> {
  const rows = await owner.$queryRawUnsafe<Array<{ id: string; topic: string; payload: unknown }>>(`SELECT id::text, topic, payload FROM outbox WHERE workspace_id = $1::uuid AND id > $2::bigint ORDER BY id`, ws, delivered);
  for (const r of rows) {
    await handleSearchEvent(app, { message: { data: Buffer.from(JSON.stringify(r.payload)).toString("base64"), attributes: { outboxId: r.id, workspaceId: ws, orgId, topic: r.topic }, messageId: r.id }, subscription: "search-indexer" });
    delivered = r.id;
  }
}

async function envelope(name: string, region: string): Promise<string> {
  const created = await call(planner, "POST", `/workspaces/${ws}/envelopes`, { name, dimensionValues: { region }, startDate: "2026-01-01", endDate: "2026-12-31", currency: "USD", amount: "500.00", ownerId: planner.id });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const s = await call(planner, "POST", `/envelopes/${String(created.body["id"])}/submit`, { versionId: created.body["draftVersionId"] });
  expect(s.body["autoApproved"]).toBe(true);
  return String(created.body["id"]);
}

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "t020" } });
  await owner.workspace.create({ data: { id: ws, orgId, slug: `t020-${ws}`, name: "T-020", reportingCurrency: "USD", fiscalYearStartMonth: 1 } });
  await owner.user.createMany({ data: [planner, scoped, admin, orgAdmin].map((u) => ({ id: u.id, orgId, email: u.email, name: u.sub, googleSub: `g-${u.sub}` })) });
  const latam = { logic: "and", children: [{ field: { kind: "dimension", key: "region" }, op: "descends_from", value: "latam" }] };
  await owner.roleAssignment.createMany({
    data: [
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: planner.id, role: "PLANNER", createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: scoped.id, role: "BUDGET_OWNER", scope: latam, createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: admin.id, role: "WORKSPACE_ADMIN", createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: null, principalType: "user", principalId: orgAdmin.id, role: "ORG_ADMIN", createdBy: orgAdmin.id },
    ],
  });
  const region = randomUUID();
  await owner.$executeRawUnsafe(`INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by) VALUES ($1::uuid, $2::uuid, NULL, 'region', 'Region', 'ENUM', $3::uuid)`, region, orgId, orgAdmin.id);
  const ids: Record<string, string> = {};
  for (const [code, label, parent] of [["latam", "Latin America", null], ["br", "Brazil", "latam"], ["emea", "Europe", null]] as const) {
    ids[code] = randomUUID();
    await owner.$executeRawUnsafe(`INSERT INTO dimension_value (id, dimension_id, code, label, parent_value_id, aliases) VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::text[])`, ids[code], region, code, label, parent ? ids[parent] : null, code === "br" ? ["Brasil"] : []);
  }
  await owner.approvalPolicy.create({ data: { id: randomUUID(), workspaceId: ws, name: "Auto", priority: 1, conditions: {}, chain: [], blockSelfApproval: true } });
  h = await startHarness();
  env["br"] = await envelope("Brazil always-on", "br");
  env["latam"] = await envelope("LATAM brand", "latam");
  env["emea"] = await envelope("Europe launch", "emea");
  await index();
  // The registry rows above were inserted directly; a workspace's first full re-index covers them.
  await reindexWorkspace(app, { workspaceId: ws, orgId });
}, 60_000);

afterAll(async () => {
  await h?.close();
  const envs = `(SELECT id FROM envelope WHERE workspace_id = $1::uuid)`;
  for (const sql of [
    `DELETE FROM search_document WHERE workspace_id = $1::uuid`,
    `DELETE FROM processed_event WHERE outbox_id IN (SELECT id FROM outbox WHERE workspace_id = $1::uuid)`,
    `DELETE FROM notification WHERE workspace_id = $1::uuid`,
    `DELETE FROM subscription WHERE workspace_id = $1::uuid`,
    `DELETE FROM taggable WHERE workspace_id = $1::uuid`,
    `DELETE FROM tag WHERE workspace_id = $1::uuid`,
    `DELETE FROM comment WHERE thread_id IN (SELECT id FROM thread WHERE workspace_id = $1::uuid)`,
    `DELETE FROM thread WHERE workspace_id = $1::uuid`,
    `DELETE FROM approval_policy WHERE workspace_id = $1::uuid`,
    `UPDATE envelope SET current_version_id = NULL, draft_version_id = NULL WHERE workspace_id = $1::uuid`,
    `DELETE FROM envelope_version WHERE envelope_id IN ${envs}`,
    `DELETE FROM envelope_dimension WHERE envelope_id IN ${envs}`,
    `DELETE FROM envelope WHERE workspace_id = $1::uuid`,
    `DELETE FROM hierarchy_template WHERE workspace_id = $1::uuid`,
    `DELETE FROM outbox WHERE workspace_id = $1::uuid`,
  ]) {
    await owner.$executeRawUnsafe(sql, ws);
  }
  await owner.$executeRawUnsafe(`DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`, orgId);
  await owner.$executeRawUnsafe(`DELETE FROM dimension WHERE org_id = $1::uuid`, orgId);
  await owner.roleAssignment.deleteMany({ where: { OR: [{ workspaceId: ws }, { principalId: orgAdmin.id }] } });
  await owner.user.deleteMany({ where: { orgId } });
  await owner.workspace.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("search", () => {
  it("finds envelopes by name, path, dimension label or alias, with facets and deep links", async () => {
    const byName = await search(planner, "brazil");
    expect(titles(byName, "envelope")).toEqual(["Brazil always-on"]);
    const byAlias = await search(planner, "brasil type:envelope");
    expect(titles(byAlias, "envelope")).toEqual(["Brazil always-on"]);
    const hit = byName.find((g) => g.type === "envelope")?.hits[0] as { deepLink: string; facets: Record<string, string> } | undefined;
    expect(hit?.deepLink).toBe(`/w/${ws}/budgets?select=${env["br"]}`);
    expect(hit?.facets).toMatchObject({ budget: "500.00", actual: "0.00" });
    expect(titles(await search(planner, "owner:@me status:approved region:emea"), "envelope")).toEqual(["Europe launch"]);
  });

  it("applies the caller's dimension scope; tags and registry values stay visible", async () => {
    expect(titles(await search(scoped, "type:envelope"), "envelope")).toEqual(["Brazil always-on", "LATAM brand"]); // descends_from latam
    expect(titles(await search(planner, "type:envelope"), "envelope")).toHaveLength(3);
    expect(titles(await search(scoped, "europe"), "dimension_value")).toEqual(["Europe"]);
    expect(titles(await search(scoped, "europe"), "envelope")).toEqual([]);
  });

  it("indexes comments as they change and drops deleted ones", async () => {
    const t = await call(planner, "POST", "/threads", { anchorType: "envelope", anchorId: env["emea"], firstComment: { bodyMd: "Carnival flighting needs a second look" } });
    await index();
    expect(titles(await search(planner, "carnival"), "comment")).toEqual(["Carnival flighting needs a second look"]);
    expect(titles(await search(scoped, "carnival"), "comment")).toEqual([]); // the comment sits on an EMEA envelope
    const commentId = (t.body["comments"] as Array<{ id: string }>)[0]?.id as string;
    await call(planner, "DELETE", `/comments/${commentId}`);
    await index();
    expect(titles(await search(planner, "carnival"), "comment")).toEqual([]);
  });

  it("re-tags envelope documents when a tag is applied or renamed", async () => {
    const tag = await call(admin, "POST", `/workspaces/${ws}/tags`, { name: "carnaval" });
    await call(planner, "POST", "/tags/apply", { tagId: tag.body["id"], entities: [{ type: "envelope", id: env["br"] }] });
    await index();
    expect(titles(await search(planner, "tag:carnaval"), "envelope")).toEqual(["Brazil always-on"]);
    await call(admin, "PATCH", `/tags/${String(tag.body["id"])}`, { name: "carnival-2027" });
    await index();
    expect(titles(await search(planner, "tag:carnival-2027"), "envelope")).toEqual(["Brazil always-on"]);
    expect(titles(await search(planner, "tag:carnaval"), "envelope")).toEqual([]);
    expect(titles(await search(planner, "type:tag"), "tag")).toEqual(["carnival-2027"]);
  });

  it("refuses malformed qualifiers and unknown types", async () => {
    expect((await call(planner, "GET", `/workspaces/${ws}/search?q=${encodeURIComponent("budget:lots")}`)).status).toBe(422);
    expect((await call(planner, "GET", `/workspaces/${ws}/search?q=x&types=bogus`)).status).toBe(422);
    expect((await call(planner, "GET", `/workspaces/${ws}/search?q=${encodeURIComponent("updated:<soon")}`)).status).toBe(422);
  });
});

describe("suggest (Epic 0.4: a new dimension is a search qualifier at once)", () => {
  it("suggests qualifier keys and registry values; a new dimension appears on the next call", async () => {
    const keys = async (prefix: string) => ((await call(planner, "GET", `/workspaces/${ws}/search/suggest?prefix=${encodeURIComponent(prefix)}`)).body["keys"] as Array<{ key: string }>).map((k) => k.key);
    expect(await keys("re")).toEqual(["region"]);
    expect(await keys("sta")).toEqual(["status"]);
    const values = (await call(planner, "GET", `/workspaces/${ws}/search/suggest?prefix=${encodeURIComponent("region:la")}`)).body["values"];
    expect(values).toEqual([{ value: "latam", label: "Latin America" }]);

    const started = performance.now();
    const created = await call(orgAdmin, "POST", `/workspaces/${ws}/dimensions`, { key: "retailer", label: "Retailer", dataType: "ENUM", icon: "lucide:store", workspaceId: ws });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(await keys("ret")).toEqual(["retailer"]);
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});
