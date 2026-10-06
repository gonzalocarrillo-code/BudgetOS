import { randomUUID } from "node:crypto";
import { SETTINGS } from "@budget/domain";
import { deleteWorkspaceForTests, handleSearchEvent, reindexWorkspace } from "@budget/workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appDb, ownerDb, startHarness, testUser, type Harness, type TestUser } from "../../test-support/harness.js";
import { perfBudgetMs } from "../../test-support/perf.js";

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
const search = async (user: TestUser, q: string, limit = 20) => {
  const res = await call(user, "GET", `/workspaces/${ws}/search?q=${encodeURIComponent(q)}&limit=${limit}`);
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
  // W3-11 (audit I-32): deletes every row that FKs to this workspace (and the workspace row
  // itself, including envelope_dimension, which references dimension_value) in the same order
  // `purgeWorkspace` validates against production — before the org-level dimension cleanup below.
  await deleteWorkspaceForTests(owner, ws);
  await owner.$executeRawUnsafe(`UPDATE dimension_value SET parent_value_id = NULL, merged_into_id = NULL WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`, orgId); // W3-11 (I-32): self-ref FK
  await owner.$executeRawUnsafe(`DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`, orgId);
  await owner.$executeRawUnsafe(`DELETE FROM dimension WHERE org_id = $1::uuid`, orgId);
  await owner.roleAssignment.deleteMany({ where: { principalId: orgAdmin.id } });
  await owner.user.deleteMany({ where: { orgId } });
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

  it("a misspelling finds by similarity only when nothing matches the words exactly (T-034)", async () => {
    expect(titles(await search(planner, "brazl type:envelope"), "envelope")).toEqual(["Brazil always-on"]);
    // "europe" matches exactly, so near misses by similarity are not added
    expect(titles(await search(planner, "europe type:envelope"), "envelope")).toEqual(["Europe launch"]);
  });

  it("a common word ranks and counts at most 1,000 matches per type and says there are more (T-034)", async () => {
    await owner.$executeRawUnsafe(
      `INSERT INTO search_document (workspace_id, entity_type, entity_id, title, path, body, updated_at)
       SELECT $1::uuid, 'comment', gen_random_uuid(), 'note ' || g, '', 'zebracrossing plan ' || g, now() FROM generate_series(1, 1001) g`,
      ws,
    );
    try {
      const res = await call(planner, "GET", `/workspaces/${ws}/search?q=zebracrossing&limit=5`);
      const g = (res.body["groups"] as Array<{ type: string; count: number; more: boolean; hits: unknown[] }>).find((x) => x.type === "comment");
      expect(g).toMatchObject({ count: 1000, more: true });
      expect(g?.hits).toHaveLength(5);
      // the word list learned the new word: a misspelling of it is corrected
      expect((await search(planner, "zebracrosing")).find((x) => x.type === "comment")?.count).toBe(1000);
      // under the cap the count is exact
      const envelopes = (await search(planner, "brazil")).find((x) => x.type === "envelope") as { count: number; more: boolean } | undefined;
      expect(envelopes).toMatchObject({ count: 1, more: false });
    } finally {
      await owner.$executeRawUnsafe(`DELETE FROM search_document WHERE workspace_id = $1::uuid AND body LIKE 'zebracrossing plan %'`, ws);
    }
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

  it("a comment reads @Name, not its mention token, and opens where its thread lives", async () => {
    await call(planner, "POST", "/threads", { anchorType: "envelope", anchorId: env["emea"], firstComment: { bodyMd: `@[user:${orgAdmin.id}] zebra budget needs a look` } });
    await index();
    const hit = ((await search(planner, "zebra")).find((g) => g.type === "comment")?.hits ?? [])[0] as { title: string; deepLink: string } | undefined;
    const name = (await owner.user.findUniqueOrThrow({ where: { id: orgAdmin.id }, select: { name: true } })).name;
    expect(hit?.title).toBe(`@${name} zebra budget needs a look`);
    expect(hit?.deepLink).toBe(`/w/${ws}/budgets?select=${encodeURIComponent(JSON.stringify(env["emea"]))}&tab=${encodeURIComponent(JSON.stringify("comments"))}`);
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

describe("settings (T-041: typing a setting name in ⌘K opens the right admin page)", () => {
  it("indexes the settings catalog; a setting's name leads the results and deep-links to its admin page", async () => {
    const count = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM search_document WHERE workspace_id = $1::uuid AND entity_type = 'setting'`, ws);
    expect(Number(count[0]?.n)).toBe(SETTINGS.length);
    for (const [q, title, link] of [
      ["pacing rules", "Pacing rules", "/admin/rules"],
      ["approval pol", "Approval policies", "/admin/policies"],
      ["match keys", "Match keys", `/admin/naming?kind=${encodeURIComponent('"match_key"')}`],
      ["metric library", "Metric library", `/admin/registry?tab=${encodeURIComponent('"metrics"')}`],
      ["guided tours", "Guided tours", "/admin/tours"],
    ] as const) {
      const groups = await search(planner, q);
      expect(groups[0]?.type, q).toBe("setting");
      expect(groups[0]?.hits[0]?.title, q).toBe(title);
      expect(groups[0]?.hits[0]?.deepLink, q).toBe(`/w/${ws}${link}`);
    }
    // Keywords find a setting too ("snowflake" → Data sources); settings are for every role.
    expect(titles(await search(scoped, "snowflake"), "setting")).toContain("Data sources");
    expect(titles(await search(planner, "type:settings", 50), "setting")).toHaveLength(SETTINGS.length);
  });

  it("a created workspace gets the catalog from its workspace.created event", async () => {
    await owner.$executeRawUnsafe(`DELETE FROM search_document WHERE workspace_id = $1::uuid AND entity_type = 'setting'`, ws);
    expect(await search(planner, "type:settings")).toEqual([]);
    const payload = { workspaceId: ws };
    const [row] = await owner.$queryRawUnsafe<Array<{ id: string }>>(`INSERT INTO outbox (workspace_id, topic, payload) VALUES ($1::uuid, 'workspace.created', $2::jsonb) RETURNING id::text`, ws, JSON.stringify(payload));
    await handleSearchEvent(app, { message: { data: Buffer.from(JSON.stringify(payload)).toString("base64"), attributes: { outboxId: row?.id ?? "", workspaceId: ws, orgId, topic: "workspace.created" }, messageId: `t041-${row?.id}` }, subscription: "search-indexer" });
    expect(titles(await search(planner, "type:settings", 50), "setting")).toHaveLength(SETTINGS.length);
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
    expect(performance.now() - started).toBeLessThan(perfBudgetMs(10_000));
  });
});
