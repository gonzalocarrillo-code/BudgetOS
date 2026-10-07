import { randomUUID } from "node:crypto";
import { asOrgAdmin, ensurePartitions, type Tx } from "@budget/db";
import type { ChatClient } from "@budget/ai";
import { deleteWorkspaceForTests } from "@budget/workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ownerDb, startHarness, testUser, type Harness, type Method, type TestUser } from "../../test-support/harness.js";

/**
 * EX-6 (ADR-0092) API: the workspace's campaign naming convention (edited in Registry): built-in
 * dictionaries read tokens nobody listed, values are created from them on demand, "map to…" stores
 * an alias, "Analyze names" proposes a convention, "Suggest with AI" (mocked client here) only
 * suggests. Every write: one audit_event + one outbox row.
 */

// The AI client is mocked: a key in the environment gives this fake instead of OpenAI.
const aiAnswer = {
  delimiter: "_",
  positions: [
    { dimension: "country", confidence: 0.95 },
    { dimension: "platform", confidence: 0.9 },
    { dimension: "audience", confidence: 0.8 },
  ],
  mappings: [{ position: 3, token: "Zzz", value: "retargeting", confidence: 0.6 }],
};
const sentToAi: string[] = [];
vi.mock("@budget/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@budget/ai")>();
  const fake: ChatClient = {
    chat: {
      completions: {
        create: async (body) => {
          sentToAi.push(body.messages.map((m) => m.content).join("\n"));
          return { choices: [{ message: { content: JSON.stringify(aiAnswer) } }] };
        },
      },
    },
  };
  return { ...actual, openAiClient: (env: NodeJS.ProcessEnv = process.env) => (env["OPENAI_API_KEY"] === "test-key" ? fake : actual.openAiClient(env)) };
});

const owner = ownerDb();
let h: Harness;
const orgId = randomUUID();
const ws = randomUUID();
const admin = testUser("ex6-admin", randomUUID());
const dataAdmin = testUser("ex6-data", randomUUID());
const viewer = testUser("ex6-viewer", randomUUID());
const X = { "x-workspace-id": ws };
let seq = 0;
const rid = () => `ex6api-${++seq}-${orgId}`;
const env: Record<string, string> = {};
const runId = randomUUID();
let savedKey: string | undefined;

async function call(user: TestUser, method: Method, url: string, body?: unknown, requestId = rid()) {
  return h.call(method, `/api/v1${url}`, await h.mint(user), { headers: { ...X, "x-request-id": requestId }, ...(body === undefined ? {} : { body }) });
}
const asAdmin = <T,>(fn: (tx: Tx) => Promise<T>) => asOrgAdmin(owner, fn, orgId);
const audits = async (requestId: string) => asAdmin((tx) => tx.$queryRawUnsafe<Array<{ action: string; after: Record<string, unknown> }>>(`SELECT action, after FROM audit_event WHERE request_id = $1 ORDER BY occurred_at`, requestId));
const outboxRows = async (topic: string) => asAdmin((tx) => tx.$queryRawUnsafe<Array<{ payload: Record<string, unknown> }>>(`SELECT payload FROM outbox WHERE workspace_id = $1::uuid AND topic = $2 ORDER BY outbox.id`, ws, topic));
const liveConventions = async () => asAdmin((tx) => tx.$queryRawUnsafe<Array<{ id: string; tokens: unknown }>>(`SELECT id::text, tokens FROM naming_convention WHERE workspace_id = $1::uuid AND deleted_at IS NULL`, ws));
const factEnvelope = async (id: string) => (await asAdmin((tx) => tx.$queryRawUnsafe<Array<{ envelope_id: string | null }>>(`SELECT envelope_id::text FROM spend_fact WHERE id = $1::uuid`, id)))[0]?.envelope_id ?? null;

async function fact(dims: Record<string, string>, amount: string): Promise<string> {
  const id = randomUUID();
  await asAdmin((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO spend_fact (id, workspace_id, dimension_values, period_date, currency, amount, amount_reporting, source_system, source_run_id, source_row_hash, natural_key)
       VALUES ($1::uuid, $2::uuid, $3::jsonb, '2026-03-01', 'USD', $4::numeric, $4::numeric, 'test', $5::uuid, $6, $6)`,
      id,
      ws,
      JSON.stringify(dims),
      amount,
      runId,
      `ex6api-${id}`,
    ),
  );
  return id;
}

async function envelope(name: string, tuple: Record<string, string>): Promise<string> {
  const id = randomUUID();
  await asAdmin((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO envelope (id, workspace_id, name, dimension_values, start_date, end_date, currency, status, created_by, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, '2026-01-01', '2026-12-31', 'USD', 'APPROVED', $5::uuid, now())`,
      id,
      ws,
      name,
      JSON.stringify(tuple),
      admin.id,
    ),
  );
  return id;
}

const convention = { delimiter: "_", tokens: [{ dimension: "country", aliases: {} }, { dimension: "platform", aliases: {} }, { dimension: "audience", aliases: {} }] };
const facts: Record<string, string> = {};

beforeAll(async () => {
  savedKey = process.env["OPENAI_API_KEY"];
  delete process.env["OPENAI_API_KEY"];
  await owner.organization.create({ data: { id: orgId, name: "ex6-api" } });
  await asAdmin((tx) => tx.workspace.create({ data: { id: ws, orgId, slug: `ex6-${ws}`, name: "EX-6", reportingCurrency: "USD" } }));
  await owner.user.createMany({ data: [admin, dataAdmin, viewer].map((u) => ({ id: u.id, orgId, email: u.email, name: u.email, googleSub: `g-${u.sub}` })) });
  await owner.roleAssignment.createMany({
    data: [
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: admin.id, role: "WORKSPACE_ADMIN", createdBy: admin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: dataAdmin.id, role: "DATA_ADMIN", createdBy: admin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: viewer.id, role: "VIEWER", createdBy: admin.id },
    ],
  });
  await ensurePartitions(owner, "2026-01-01", "2026-12-31");
  // The registry knows only BR and meta: GB, prospecting and retargeting come from the dictionaries.
  const campaigns = [
    ["c-1", "BR_FB_Prospecting"],
    ["c-2", "UK_Meta_Retargeting"],
    ["c-3", "Brasil_Instagram_Zzz"],
  ] as const;
  await asAdmin(async (tx) => {
    for (const [key, values] of [["country", [["BR", "Brazil"]]], ["platform", [["meta", "Meta"]]], ["audience", []], ["campaign", campaigns]] as const) {
      const dim = randomUUID();
      await tx.$executeRawUnsafe(`INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by) VALUES ($1::uuid, $2::uuid, NULL, $3, $3, 'ENUM', $4::uuid)`, dim, orgId, key, admin.id);
      for (const [code, label] of values) await tx.$executeRawUnsafe(`INSERT INTO dimension_value (id, dimension_id, code, label) VALUES ($1::uuid, $2::uuid, $3, $4)`, randomUUID(), dim, code, label);
    }
  });
  env["brMeta"] = await envelope("BR Meta", { country: "BR", platform: "meta" });
  env["gbMeta"] = await envelope("GB Meta", { country: "GB", platform: "meta" });
  facts["c1"] = await fact({ campaign: "c-1" }, "30.00");
  facts["c2"] = await fact({ campaign: "c-2" }, "20.00");
  facts["c3"] = await fact({ campaign: "c-3" }, "5.00");
  h = await startHarness();
}, 60_000);

afterAll(async () => {
  if (savedKey !== undefined) process.env["OPENAI_API_KEY"] = savedKey;
  else delete process.env["OPENAI_API_KEY"];
  await h?.close();
  await deleteWorkspaceForTests(owner, ws, orgId);
  await asAdmin(async (tx) => {
    await tx.$executeRawUnsafe(`DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`, orgId);
    await tx.$executeRawUnsafe(`DELETE FROM dimension WHERE org_id = $1::uuid`, orgId);
  });
  await owner.roleAssignment.deleteMany({ where: { principalId: { in: [admin.id, dataAdmin.id, viewer.id] } } });
  await owner.user.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await owner.$disconnect();
});

describe("analyze names (deterministic)", () => {
  it("only a data admin; pasted names (EX-3's demo names) → the country position is found", async () => {
    const names = ["BR_Meta_Prospecting_Q4_VideoA", "MX_GoogleAds_Retargeting_Q4_StaticB", "US_Meta_Broad_Q4_VideoD", "BR_GoogleAds_Prospecting_Q4_CarouselC"];
    expect((await call(viewer, "POST", `/workspaces/${ws}/naming-conventions/analyze`, { names })).status).toBe(403);
    const res = await call(dataAdmin, "POST", `/workspaces/${ws}/naming-conventions/analyze`, { names });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ source: "pasted", delimiter: "_", partCount: 5, fitting: 4 });
    expect(res.body["positions"]).toEqual(expect.arrayContaining([expect.objectContaining({ position: 1, best: { kind: "country", dimension: "country", hitRate: 1 } })]));
    expect((res.body["proposal"] as { tokens: Array<{ dimension: string | null }> }).tokens.map((t) => t.dimension)).toEqual(["country", "platform", "audience", null, null]);
  });

  it("without names it reads the workspace's campaign names (labels), largest spend first", async () => {
    const res = await call(dataAdmin, "POST", `/workspaces/${ws}/naming-conventions/analyze`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ source: "facts", delimiter: "_", partCount: 3, total: 3 });
    expect((res.body["positions"] as Array<{ examples: string[] }>)[0]?.examples).toEqual(["BR", "UK", "Brasil"]);
  });
});

describe("the workspace's convention", () => {
  let firstId = "";

  it("starts empty; AI is not available without OPENAI_API_KEY", async () => {
    const res = await call(viewer, "GET", `/workspaces/${ws}/naming-convention`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ convention: null, others: 0, aiAvailable: false });
  });

  it("saving it (data admin only) creates dictionary values on demand and re-matches; one audit_event + one facts.loaded", async () => {
    expect((await call(viewer, "PUT", `/workspaces/${ws}/naming-convention`, convention)).status).toBe(403);
    const requestId = rid();
    const res = await call(dataAdmin, "PUT", `/workspaces/${ws}/naming-convention`, convention, requestId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    firstId = String((res.body["convention"] as { id: string }).id);
    expect(res.body["createdValues"]).toEqual([
      { dimension: "audience", code: "prospecting", label: "Prospecting" },
      { dimension: "country", code: "GB", label: "United Kingdom" },
      { dimension: "audience", code: "retargeting", label: "Retargeting" },
    ]);
    // UK → GB (dictionary), FB → meta (dictionary onto the registry's meta).
    expect(await factEnvelope(facts["c1"] as string)).toBe(env["brMeta"]);
    expect(await factEnvelope(facts["c2"] as string)).toBe(env["gbMeta"]);
    expect(await factEnvelope(facts["c3"] as string)).toBeNull();
    const a = await audits(requestId);
    expect(a.map((r) => r.action)).toEqual(["naming_convention.saved"]);
    expect((await outboxRows("facts.loaded")).filter((r) => r.payload["namingConventionId"] === firstId)).toHaveLength(1);
    const values = await asAdmin((tx) => tx.$queryRawUnsafe<Array<{ code: string }>>(`SELECT v.code FROM dimension_value v JOIN dimension d ON d.id = v.dimension_id WHERE d.org_id = $1::uuid AND d.key = 'country' ORDER BY v.code`, orgId));
    expect(values.map((v) => v.code)).toEqual(["BR", "GB"]);
    expect((await call(viewer, "GET", `/workspaces/${ws}/naming-convention`)).body).toMatchObject({ convention: { id: firstId, delimiter: "_" }, others: 0 });
  });

  it("the preview explains every part and lists unresolved tokens with their spend", async () => {
    const res = await call(dataAdmin, "POST", `/workspaces/${ws}/naming-conventions/preview`, { convention });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const samples = res.body["samples"] as Array<{ name: string; parts: Array<{ source: string | null }> }>;
    expect(samples.find((s) => s.name === "UK_Meta_Retargeting")?.parts.map((p) => p.source)).toEqual(["dictionary", "registry", "registry"]);
    expect(res.body["unresolved"]).toEqual([{ position: 3, dimension: "audience", token: "Zzz", campaigns: 1, amount: "5.00" }]);
  });

  it("'map to…' stores an alias as a new version of the convention; one audit_event + one facts.loaded", async () => {
    expect((await call(viewer, "POST", `/workspaces/${ws}/naming-convention/aliases`, { dimension: "audience", token: "Zzz", value: "retargeting" })).status).toBe(403);
    expect((await call(dataAdmin, "POST", `/workspaces/${ws}/naming-convention/aliases`, { dimension: "client", token: "Zzz", value: "x" })).status).toBe(422);
    expect((await call(dataAdmin, "POST", `/workspaces/${ws}/naming-convention/aliases`, { dimension: "audience", token: "Zzz", value: "nothing-like-it" })).status).toBe(422);
    const requestId = rid();
    const res = await call(dataAdmin, "POST", `/workspaces/${ws}/naming-convention/aliases`, { dimension: "audience", token: "Zzz", value: "Remarketing" }, requestId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const id = String((res.body["convention"] as { id: string }).id);
    expect(id).not.toBe(firstId);
    expect(res.body["convention"]).toMatchObject({ tokens: [{ dimension: "country" }, { dimension: "platform" }, { dimension: "audience", aliases: { Zzz: "retargeting" } }] });
    expect((await liveConventions()).map((c) => c.id)).toEqual([id]);
    expect(await audits(requestId)).toEqual([expect.objectContaining({ action: "naming_convention.alias_added" })]);
    expect((await outboxRows("facts.loaded")).filter((r) => r.payload["namingConventionId"] === id)).toHaveLength(1);
    const saved = res.body["convention"] as { delimiter: string; tokens: unknown[] };
    const preview = await call(dataAdmin, "POST", `/workspaces/${ws}/naming-conventions/preview`, { convention: { delimiter: saved.delimiter, tokens: saved.tokens } });
    expect(preview.body["unresolved"]).toEqual([]);
  });
});

describe("suggest with AI (support only)", () => {
  it("is 503 without OPENAI_API_KEY", async () => {
    const res = await call(dataAdmin, "POST", `/workspaces/${ws}/naming-conventions/suggest`, {});
    expect(res.status).toBe(503);
  });

  it("sends only names, validates the answer, applies nothing, audits who and how many", async () => {
    process.env["OPENAI_API_KEY"] = "test-key";
    try {
      expect((await call(viewer, "GET", `/workspaces/${ws}/naming-convention`)).body).toMatchObject({ aiAvailable: true });
      expect((await call(viewer, "POST", `/workspaces/${ws}/naming-conventions/suggest`, {})).status).toBe(403);
      const before = await liveConventions();
      const requestId = rid();
      const res = await call(dataAdmin, "POST", `/workspaces/${ws}/naming-conventions/suggest`, {}, requestId);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ applied: false, names: 3, suggestion: aiAnswer, proposal: { delimiter: "_", tokens: [{ dimension: "country" }, { dimension: "platform" }, { dimension: "audience" }] } });
      expect(await liveConventions()).toEqual(before);
      const sent = sentToAi.at(-1) ?? "";
      expect(sent).toContain("UK_Meta_Retargeting");
      expect(sent).not.toMatch(/20\.00|c-2|[0-9a-f]{8}-[0-9a-f]{4}-/);
      const a = await audits(requestId);
      expect(a).toEqual([{ action: "naming_convention.ai_suggested", after: expect.objectContaining({ names: 3 }) }]);
      expect(JSON.stringify(a[0]?.after)).not.toContain("UK_Meta");
      expect((await outboxRows("source.changed")).filter((r) => r.payload["action"] === "naming_convention.ai_suggested")).toHaveLength(1);
    } finally {
      delete process.env["OPENAI_API_KEY"];
    }
  });
});
