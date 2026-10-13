import { randomUUID } from "node:crypto";
import { asOrgAdmin, ensurePartitions, type Tx } from "@budget/db";
import type { ChatClient } from "@budget/ai";
import { dictionaryToCsv, parseDictionaryCsv } from "@budget/domain";
import { deleteWorkspaceForTests } from "@budget/workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ownerDb, startHarness, testUser, type Harness, type Method, type TestUser } from "../../test-support/harness.js";

/**
 * EX-7 (ADR-0093) API: naming dictionaries are data. The owner's real campaign names (16 parts,
 * client codes no built-in list knows, a MMDDYY date, free text) with a convention of granularity,
 * ignore, date and free-text positions; built-in entries seeded once and editable; your entries
 * defined from unresolved tokens re-match the facts; bulk paste, CSV round-trip, reset to built-in,
 * EX-6 aliases migrated; "Fill dictionary with AI" (mocked) writes nothing until rows are accepted.
 * Every write: one audit_event + one outbox row.
 */

const aiAnswer = { entries: [{ code: "GNB", meaning: "Google Nest & Business", value: null, confidence: 0.8 }, { code: "YTB", meaning: "YouTube", value: "youtube", confidence: 0.9 }, { code: "NOT-SENT", meaning: "?", value: null, confidence: 1 }] };
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

const NAMES = [
  "GOOG_C_SEM_GNB_Core-Translate_WA_BAU_ACQ_PER_MIX_ALL_NAMER_US_EN_020426_General",
  "GOOG_C_SEM_GCP_Core_WA_BAU_ACQ_PER_MIX_ALL_NAMER_US_EN_013125_General",
  "GOOG_G_PRG_YTB_Codex_BR_BAU_VID_PER_PHR_ALL_NAMER_US_EN_060126_KnowledgeWorker",
  "GOOG_G_SEM_GBR_Core_CW_BAU_ACQ_PER_DMA_ALL_NAMER_US_EN_031826_Developer",
];

const owner = ownerDb();
let h: Harness;
const orgId = randomUUID();
const ws = randomUUID();
const admin = testUser("ex7-admin", randomUUID());
const dataAdmin = testUser("ex7-data", randomUUID());
const viewer = testUser("ex7-viewer", randomUUID());
const X = { "x-workspace-id": ws };
let seq = 0;
const rid = () => `ex7api-${++seq}-${orgId}`;
const runId = randomUUID();
let savedKey: string | undefined;
const facts: string[] = [];
let gnbEnvelope = "";

async function call(user: TestUser, method: Method, url: string, body?: unknown, requestId = rid()) {
  return h.call(method, `/api/v1${url}`, await h.mint(user), { headers: { ...X, "x-request-id": requestId }, ...(body === undefined ? {} : { body }) });
}
const asAdmin = <T,>(fn: (tx: Tx) => Promise<T>) => asOrgAdmin(owner, fn, orgId);
const audits = async (requestId: string) => asAdmin((tx) => tx.$queryRawUnsafe<Array<{ action: string; after: Record<string, unknown> }>>(`SELECT action, after FROM audit_event WHERE request_id = $1 ORDER BY occurred_at`, requestId));
const outboxCount = async () => Number((await asAdmin((tx) => tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE workspace_id = $1::uuid`, ws)))[0]?.n ?? 0);
const factEnvelope = async (id: string) => (await asAdmin((tx) => tx.$queryRawUnsafe<Array<{ envelope_id: string | null }>>(`SELECT envelope_id::text FROM spend_fact WHERE id = $1::uuid`, id)))[0]?.envelope_id ?? null;
const liveEntries = async (key: string) => asAdmin((tx) => tx.$queryRawUnsafe<Array<{ code: string; value: string; label: string; source: string }>>(`SELECT code, value, label, source FROM naming_dictionary_entry WHERE workspace_id = $1::uuid AND dimension_key = $2 AND deleted_at IS NULL ORDER BY code_norm`, ws, key));
type Dict = { seeded: boolean; total: number; kind: string | null; entries: Array<{ id: string | null; code: string; meaning: string; value: string; source: string; legacy: boolean; notes: string | null }> };
const dictionary = async (key: string, q = "") => (await call(viewer, "GET", `/workspaces/${ws}/naming-dictionaries/${key}?limit=5000${q ? `&q=${encodeURIComponent(q)}` : ""}`)).body as unknown as Dict;

/** One write = one audit_event (this request) + one outbox row. */
async function expectOneAuditAndOutbox(requestId: string, action: string, before: number) {
  expect((await audits(requestId)).map((a) => a.action)).toEqual([action]);
  expect(await outboxCount()).toBe(before + 1);
}

const ignore = { dimension: null, aliases: {}, kind: "ignore" };
const dim = (d: string) => ({ dimension: d, aliases: {}, kind: "dimension" });
const convention = {
  delimiter: "_",
  tokens: [ignore, ignore, dim("channel"), dim("product"), ignore, ignore, ignore, ignore, ignore, ignore, ignore, dim("region"), dim("country"), dim("language"), { dimension: null, aliases: {}, kind: "date", datePattern: "MMDDYY" }, { dimension: null, aliases: {}, kind: "free_text", attribute: "audience_note" }],
};

beforeAll(async () => {
  savedKey = process.env["OPENAI_API_KEY"];
  delete process.env["OPENAI_API_KEY"];
  await owner.organization.create({ data: { id: orgId, name: "ex7-api" } });
  await asAdmin((tx) => tx.workspace.create({ data: { id: ws, orgId, slug: `ex7-${ws}`, name: "EX-7", reportingCurrency: "USD" } }));
  await owner.user.createMany({ data: [admin, dataAdmin, viewer].map((u) => ({ id: u.id, orgId, email: u.email, name: u.email, googleSub: `g-${u.sub}` })) });
  await owner.roleAssignment.createMany({
    data: [
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: admin.id, role: "WORKSPACE_ADMIN", createdBy: admin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: dataAdmin.id, role: "DATA_ADMIN", createdBy: admin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: viewer.id, role: "VIEWER", createdBy: admin.id },
    ],
  });
  await ensurePartitions(owner, "2026-01-01", "2026-12-31");
  await asAdmin(async (tx) => {
    const dims: Array<[string, Array<[string, string]>]> = [
      ["channel", [["paid_search", "Paid search"], ["programmatic", "Programmatic"]]],
      ["product", [["youtube", "YouTube"]]],
      ["tactic", []],
      ["region", []],
      ["country", [["US", "United States"]]],
      ["language", [["en", "English"]]],
      ["campaign", NAMES.map((n, i) => [`c-${i}`, n])],
    ];
    for (const [key, values] of dims) {
      const id = randomUUID();
      await tx.$executeRawUnsafe(`INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by) VALUES ($1::uuid, $2::uuid, NULL, $3, initcap($3), 'ENUM', $4::uuid)`, id, orgId, key, admin.id);
      for (const [code, label] of values) await tx.$executeRawUnsafe(`INSERT INTO dimension_value (id, dimension_id, code, label) VALUES ($1::uuid, $2::uuid, $3, $4)`, randomUUID(), id, code, label);
    }
    gnbEnvelope = randomUUID();
    await tx.$executeRawUnsafe(
      `INSERT INTO envelope (id, workspace_id, name, dimension_values, start_date, end_date, currency, status, created_by, updated_at) VALUES ($1::uuid, $2::uuid, 'GNB US', $3::jsonb, '2026-01-01', '2026-12-31', 'USD', 'APPROVED', $4::uuid, now())`,
      gnbEnvelope,
      ws,
      JSON.stringify({ product: "gnb", country: "US" }),
      admin.id,
    );
    for (const [i, amount] of ["40.00", "30.00", "20.00", "10.00"].entries()) {
      const id = randomUUID();
      facts.push(id);
      await tx.$executeRawUnsafe(
        `INSERT INTO spend_fact (id, workspace_id, dimension_values, period_date, currency, amount, amount_reporting, source_system, source_run_id, source_row_hash, natural_key)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, '2026-03-01', 'USD', $4::numeric, $4::numeric, 'test', $5::uuid, $6, $6)`,
        id,
        ws,
        JSON.stringify({ campaign: `c-${i}` }),
        amount,
        runId,
        `ex7api-${id}`,
      );
    }
  });
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

describe("EX-6 aliases become dictionary entries", () => {
  it("an EX-6 alias is listed (read-only) until the next write copies it into the dictionary", async () => {
    const legacy = { delimiter: "_", tokens: convention.tokens.map((t, i) => (i === 11 ? { dimension: "region", aliases: { NAMER: "AMER" } } : t.kind === "dimension" ? { dimension: t.dimension, aliases: {} } : { dimension: null, aliases: {} })) };
    expect((await call(dataAdmin, "POST", `/workspaces/${ws}/naming-conventions`, legacy)).status).toBe(201);
    const before = await dictionary("region");
    expect(before.entries).toEqual([expect.objectContaining({ id: null, code: "NAMER", value: "AMER", source: "user", legacy: true })]);
    expect(await liveEntries("region")).toEqual([]);
    // Any dictionary write copies the aliases first.
    const res = await call(dataAdmin, "POST", `/workspaces/${ws}/naming-dictionaries/tactic/entries`, { code: "BAU", meaning: "Business as usual" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await liveEntries("region")).toEqual([{ code: "NAMER", value: "AMER", label: "AMER", source: "user" }]);
    expect((await dictionary("region")).entries).toEqual([expect.objectContaining({ code: "NAMER", legacy: false })]);
  });
});

describe("the convention with ignore, date and free-text positions", () => {
  it("saving seeds the built-in dictionaries of the granularities it uses, once", async () => {
    const res = await call(dataAdmin, "PUT", `/workspaces/${ws}/naming-convention`, convention);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const country = await dictionary("country");
    expect(country).toMatchObject({ kind: "country", seeded: true });
    expect(country.total).toBeGreaterThan(600);
    expect((await dictionary("country", "Reino Unido")).entries).toEqual([expect.objectContaining({ code: "Reino Unido", value: "GB", source: "builtin" })]);
    // The product granularity has no built-in list: it starts empty.
    expect(await dictionary("product")).toMatchObject({ kind: null, seeded: false, total: 0 });
    const n = country.total;
    expect((await call(dataAdmin, "PUT", `/workspaces/${ws}/naming-convention`, { ...convention, tokens: [...convention.tokens.slice(0, 15), { ...convention.tokens[15], attribute: "note" }] })).status).toBe(200);
    expect((await dictionary("country")).total).toBe(n);
  });

  it("the preview splits only on the separator, reads the date and free text, and lists unresolved product codes per position", async () => {
    const res = await call(dataAdmin, "POST", `/workspaces/${ws}/naming-conventions/preview`, { convention });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const samples = res.body["samples"] as Array<{ name: string; parts: Array<{ raw: string; kind: string }>; attributes: Record<string, string> }>;
    const first = samples.find((s) => s.name === NAMES[0]);
    expect(first?.parts).toHaveLength(16);
    expect(first?.parts[4]?.raw).toBe("Core-Translate");
    expect(first?.attributes).toEqual({ launch_date: "2026-02-04", audience_note: "General" });
    const unresolved = res.body["unresolved"] as Array<{ position: number; token: string; campaigns: number; amount: string }>;
    expect(unresolved.filter((u) => u.position === 4).map((u) => [u.token, u.campaigns, u.amount])).toEqual([
      ["GNB", 1, "40.00"],
      ["GCP", 1, "30.00"],
      ["YTB", 1, "20.00"],
      ["GBR", 1, "10.00"],
    ]);
    // No ignored position ever shows up as unresolved.
    expect(unresolved.every((u) => [3, 4, 12, 13, 14].includes(u.position))).toBe(true);
  });
});

describe("dictionary entries", () => {
  let gnbId = "";

  it("'Define' an unresolved code: data admin only; one audit + one outbox; the facts re-match onto the new value", async () => {
    expect((await call(viewer, "POST", `/workspaces/${ws}/naming-dictionaries/product/entries`, { code: "GNB", meaning: "Google Nest & Business" })).status).toBe(403);
    expect((await call(dataAdmin, "POST", `/workspaces/${ws}/naming-dictionaries/campaign/entries`, { code: "X", meaning: "x" })).status).toBe(422);
    expect((await call(dataAdmin, "POST", `/workspaces/${ws}/naming-dictionaries/planet/entries`, { code: "X", meaning: "x" })).status).toBe(404);
    // NAMER (region) → AMER came from the EX-6 alias; channel SEM / PRG and language EN are read already.
    expect(await factEnvelope(facts[0] as string)).toBeNull();
    const before = await outboxCount();
    const requestId = rid();
    const res = await call(dataAdmin, "POST", `/workspaces/${ws}/naming-dictionaries/product/entries`, { code: "GNB", meaning: "Google Nest & Business", value: "gnb" }, requestId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ written: 1, createdValues: [{ dimension: "product", code: "gnb", label: "Google Nest & Business" }] });
    await expectOneAuditAndOutbox(requestId, "naming_dictionary.entry_added", before);
    expect(await factEnvelope(facts[0] as string)).toBe(gnbEnvelope);
    gnbId = String((await dictionary("product")).entries.find((e) => e.code === "GNB")?.id);
  });

  it("edit and delete: soft, audited; an edit is a new row", async () => {
    const before = await outboxCount();
    const requestId = rid();
    const res = await call(dataAdmin, "PATCH", `/workspaces/${ws}/naming-dictionaries/product/entries/${gnbId}`, { meaning: "Google Nest", notes: "client code" }, requestId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await expectOneAuditAndOutbox(requestId, "naming_dictionary.entry_updated", before);
    const after = (await dictionary("product")).entries.find((e) => e.code === "GNB");
    expect(after).toMatchObject({ meaning: "Google Nest", notes: "client code", value: "gnb" });
    expect(after?.id).not.toBe(gnbId);
    const rows = await asAdmin((tx) => tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM naming_dictionary_entry WHERE workspace_id = $1::uuid AND dimension_key = 'product' AND code = 'GNB'`, ws));
    expect(Number(rows[0]?.n)).toBe(2);
    gnbId = String(after?.id);
    expect(await factEnvelope(facts[0] as string)).toBe(gnbEnvelope);
  });

  it("synced entries are read-only", async () => {
    const id = randomUUID();
    await asAdmin((tx) => tx.$executeRawUnsafe(`INSERT INTO naming_dictionary_entry (id, workspace_id, dimension_key, code, code_norm, value, label, source, sync_source_id, created_by) VALUES ($1::uuid, $2::uuid, 'tactic', 'VID', 'vid', 'video', 'Video', 'sync', $3::uuid, $4::uuid)`, id, ws, randomUUID(), admin.id));
    expect((await call(dataAdmin, "PATCH", `/workspaces/${ws}/naming-dictionaries/tactic/entries/${id}`, { meaning: "x" })).status).toBe(423);
    expect((await call(dataAdmin, "DELETE", `/workspaces/${ws}/naming-dictionaries/tactic/entries/${id}`)).status).toBe(423);
    expect((await dictionary("tactic")).entries.find((e) => e.code === "VID")).toMatchObject({ source: "sync" });
  });

  it("bulk paste: one audit + one outbox for the lot; skip keeps existing codes", async () => {
    const before = await outboxCount();
    const requestId = rid();
    const res = await call(dataAdmin, "POST", `/workspaces/${ws}/naming-dictionaries/tactic/bulk`, { entries: [{ code: "ACQ", meaning: "Acquisition" }, { code: "PER", meaning: "Performance" }, { code: "BAU", meaning: "changed" }], onConflict: "skip" }, requestId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ written: 2, skipped: 1 });
    await expectOneAuditAndOutbox(requestId, "naming_dictionary.bulk_written", before);
    expect((await liveEntries("tactic")).map((e) => [e.code, e.label])).toEqual([
      ["ACQ", "Acquisition"],
      ["BAU", "Business as usual"],
      ["PER", "Performance"],
      ["VID", "Video"],
    ]);
  });

  it("CSV export → import round-trips into another dictionary", async () => {
    const tactic = await dictionary("tactic");
    const csv = dictionaryToCsv(tactic.entries.filter((e) => e.source !== "sync"));
    const parsed = parseDictionaryCsv(csv);
    expect(parsed.errors).toEqual([]);
    const res = await call(dataAdmin, "POST", `/workspaces/${ws}/naming-dictionaries/language/bulk`, { entries: parsed.entries });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const back = (await dictionary("language")).entries.filter((e) => e.source === "user").map((e) => ({ code: e.code, meaning: e.meaning, value: e.value, notes: e.notes }));
    expect(back).toEqual(tactic.entries.filter((e) => e.source !== "sync").map((e) => ({ code: e.code, meaning: e.meaning, value: e.value, notes: e.notes })));
  });

  it("built-in entries are editable; 'Reset to built-in' restores them and drops yours", async () => {
    const us = (await dictionary("country", "USA")).entries.find((e) => e.code === "USA");
    expect(us).toMatchObject({ source: "builtin", value: "US" });
    expect((await call(dataAdmin, "DELETE", `/workspaces/${ws}/naming-dictionaries/country/entries/${us?.id}`)).status).toBe(200);
    expect((await dictionary("country", "USA")).entries.find((e) => e.code === "USA")).toBeUndefined();
    await call(dataAdmin, "POST", `/workspaces/${ws}/naming-dictionaries/country/entries`, { code: "Gringolandia", meaning: "US", value: "US" });
    // A deleted built-in entry stays deleted when the convention is saved again (seeded once).
    await call(dataAdmin, "PUT", `/workspaces/${ws}/naming-convention`, convention);
    expect((await dictionary("country", "USA")).entries.find((e) => e.code === "USA")).toBeUndefined();
    expect((await call(viewer, "POST", `/workspaces/${ws}/naming-dictionaries/country/reset`, {})).status).toBe(403);
    expect((await call(dataAdmin, "POST", `/workspaces/${ws}/naming-dictionaries/product/reset`, {})).status).toBe(422);
    const before = await outboxCount();
    const requestId = rid();
    const res = await call(dataAdmin, "POST", `/workspaces/${ws}/naming-dictionaries/country/reset`, {}, requestId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await expectOneAuditAndOutbox(requestId, "naming_dictionary.reset", before);
    expect((await dictionary("country", "USA")).entries.find((e) => e.code === "USA")).toMatchObject({ source: "builtin" });
    expect((await dictionary("country", "Gringolandia")).entries).toEqual([]);
  });
});

describe("fill dictionary with AI (support only)", () => {
  it("503 without OpenAI; the list says AI is off", async () => {
    expect((await call(viewer, "GET", `/workspaces/${ws}/naming-dictionaries`)).body).toMatchObject({ aiAvailable: false });
    expect((await call(dataAdmin, "POST", `/workspaces/${ws}/naming-dictionaries/product/ai-fill`, { position: 4 })).status).toBe(503);
  });

  it("sends the position's unresolved codes and example names only, writes nothing; accepted rows are written as source ai", async () => {
    process.env["OPENAI_API_KEY"] = "test-key";
    try {
      expect((await call(viewer, "POST", `/workspaces/${ws}/naming-dictionaries/product/ai-fill`, { position: 4 })).status).toBe(403);
      const before = await liveEntries("product");
      const requestId = rid();
      const res = await call(dataAdmin, "POST", `/workspaces/${ws}/naming-dictionaries/product/ai-fill`, { position: 4 }, requestId);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      // GNB is defined already; GCP, YTB? YTB reads "youtube"? No: it is unresolved too; NOT-SENT was never sent.
      expect(res.body).toMatchObject({ applied: false, dimension: "product", codes: 3 });
      expect((res.body["proposals"] as Array<{ code: string }>).map((p) => p.code)).toEqual(["YTB"]);
      expect(await liveEntries("product")).toEqual(before);
      const sent = sentToAi.at(-1) ?? "";
      expect(sent).toContain("GCP");
      expect(sent).toContain("GOOG_C_SEM_GCP_Core_WA_BAU_ACQ_PER_MIX_ALL_NAMER_US_EN_013125_General");
      expect(sent).not.toMatch(/40\.00|30\.00|c-1|[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(await audits(requestId)).toEqual([{ action: "naming_dictionary.ai_suggested", after: expect.objectContaining({ codes: 3, proposals: 1 }) }]);
      // Only the accepted row is written, as source ai.
      const accept = await call(dataAdmin, "POST", `/workspaces/${ws}/naming-dictionaries/product/bulk`, { entries: [{ code: "YTB", meaning: "YouTube", value: "youtube" }], source: "ai" });
      expect(accept.status, JSON.stringify(accept.body)).toBe(201);
      expect((await liveEntries("product")).map((e) => [e.code, e.source])).toEqual([
        ["GNB", "user"],
        ["YTB", "ai"],
      ]);
    } finally {
      delete process.env["OPENAI_API_KEY"];
    }
  });
});
