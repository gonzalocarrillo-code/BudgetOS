import { randomUUID } from "node:crypto";
import { GOLDEN_ASSERTIONS, GOLDEN_CLOSURE, GOLDEN_COLLAB, GOLDEN_CUSTOM_DIMENSIONS, GOLDEN_EXPORT, GOLDEN_FY } from "@budget/db";
import { LIVE_LEAVES } from "@budget/workers";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGolden, type GoldenResult } from "../../api/src/seed/golden.js";
import { cleanupGolden } from "../../api/src/test-support/golden-cleanup.js";
import { appDb, ownerDb, startMcp, type McpHarness } from "./test-support/harness.js";

/**
 * T-025 done-when (spec §16): every tool returns the golden numbers, over the real HTTP path with
 * per-user tokens, as `budget_mcp`. Every call writes one mcp audit row and nothing else: a
 * fingerprint of every workspace table is unchanged after all the calls. Scope applies per user;
 * a registry change is visible at once (Epic 0.4, MCP parameter clause).
 */

const A = GOLDEN_ASSERTIONS;
const owner = ownerDb();
const app = appDb();
const slug = `golden-mcp-${randomUUID().slice(0, 8)}`;
let golden: GoldenResult;
let h: McpHarness;
const tokens: Record<string, string> = {};
const period = { kind: "range", ...GOLDEN_FY };
const live = (...more: unknown[]) => ({ logic: "and", children: [...LIVE_LEAVES, ...more] });
const person = (p: string) => ({ email: `${p.toLowerCase()}@${slug}.golden.test`, googleSub: `golden-${slug}-${p}` });
const scoped = { id: randomUUID(), email: `scoped@${slug}.golden.test`, googleSub: `golden-${slug}-scoped` };

async function tool(name: string, args: Record<string, unknown> = {}, who = "finance1") {
  const res = await h.call(tokens[who] as string, name, { workspaceId: golden.workspaceId, ...args });
  expect(res.isError, JSON.stringify(res.body)).toBe(false);
  expect(typeof res.body["dataAsOf"]).toBe("string");
  return res.body["data"] as never;
}

/** md5 of every row the golden workspace has in each table with a workspace_id (audit_event aside), plus key child tables. */
async function fingerprint(): Promise<Record<string, string>> {
  const tables = await owner.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT c.table_name FROM information_schema.columns c JOIN pg_class p ON p.relname = c.table_name
     WHERE c.table_schema = 'public' AND c.column_name = 'workspace_id' AND c.table_name <> 'audit_event' AND NOT p.relispartition ORDER BY 1`,
  );
  const out: Record<string, string> = {};
  const envs = `(SELECT id FROM envelope WHERE workspace_id = $1::uuid)`;
  const sqls: Array<[string, string]> = [
    ...tables.map((t): [string, string] => [t.table_name, `SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "${t.table_name}" x WHERE x.workspace_id = $1::uuid`]),
    ["envelope_version", `SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM envelope_version x WHERE x.envelope_id IN ${envs}`],
    ["approval_decision", `SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM approval_decision x WHERE x.request_id IN (SELECT id FROM approval_request WHERE workspace_id = $1::uuid)`],
    ["comment", `SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM comment x WHERE x.thread_id IN (SELECT id FROM thread WHERE workspace_id = $1::uuid)`],
  ];
  for (const [name, sql] of sqls) out[name] = (await owner.$queryRawUnsafe<Array<{ h: string }>>(sql, golden.workspaceId))[0]?.h ?? "";
  return out;
}
const mcpAudits = async () => Number((await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM audit_event WHERE actor_type = 'mcp' AND workspace_id = $1::uuid`, golden.workspaceId))[0]?.n ?? 0);

beforeAll(async () => {
  golden = await seedGolden(app, owner, { slug });
  await owner.user.create({ data: { id: scoped.id, orgId: golden.orgId, email: scoped.email, name: "Scoped viewer", googleSub: scoped.googleSub } });
  await owner.roleAssignment.create({ data: { id: randomUUID(), workspaceId: golden.workspaceId, principalType: "user", principalId: scoped.id, role: "VIEWER", scope: { logic: "and", children: [{ field: { kind: "dimension", key: "region" }, op: "eq", value: "EMEA" }] }, createdBy: golden.users.orgAdmin } });
  h = await startMcp();
  for (const p of ["finance1", "planner", "approver", "admin"]) tokens[p] = await h.mint(person(p));
  tokens["scoped"] = await h.mint(scoped);
});

afterAll(async () => {
  await h?.close();
  if (golden) {
    await owner.roleAssignment.deleteMany({ where: { principalId: scoped.id } });
    await owner.user.deleteMany({ where: { id: scoped.id } });
    await cleanupGolden(owner, golden);
  }
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("MCP tools over the golden workspace (T-025 done-when)", () => {
  let before: Record<string, string>;
  let audits0 = 0;
  let calls = 0;
  const counted = async (name: string, args: Record<string, unknown> = {}, who = "finance1") => {
    calls += 1;
    return tool(name, args, who);
  };

  beforeAll(async () => {
    before = await fingerprint();
    audits0 = await mcpAudits();
  });

  it("every tool is declared read-only", async () => {
    const c = await h.client(tokens["finance1"] as string);
    const { tools } = await c.listTools();
    await c.close();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["describe_dimensions", "export_csv", "get_budget", "get_closure", "get_decision_timeline", "get_pacing", "list_alerts", "list_approvals", "list_tags", "list_threads", "list_workspaces", "query_budgets", "query_targets", "search"].sort(),
    );
    expect(tools.every((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false)).toBe(true);
  });

  it("list_workspaces and describe_dimensions", async () => {
    const res = await h.call(tokens["finance1"] as string, "list_workspaces");
    expect((res.body["data"] as Array<{ workspaceId: string; roles: string[] }>).find((w) => w.workspaceId === golden.workspaceId)?.roles).toEqual(["FINANCE"]);
    const reg = (await counted("describe_dimensions")) as { dimensions: Array<{ key: string; values: unknown[] }>; hierarchyTemplates: unknown[] };
    for (const d of GOLDEN_CUSTOM_DIMENSIONS) expect(reg.dimensions.map((x) => x.key)).toContain(d.key);
    expect(reg.dimensions.reduce((n, d) => n + d.values.length, 0)).toBe(A.search.dimension_value);
    expect(reg.hierarchyTemplates.length).toBe(Object.keys(A.rollup.nodesByTemplate).length);
  });

  it("query_budgets: leaf budget by region and the totals", async () => {
    const res = (await counted("query_budgets", { filter: live(), groupBy: ["region"], measures: ["budget", "actual"], period, limit: 50 })) as { rows: Array<{ dimensions: Record<string, string>; measures: Record<string, string> }>; totals: Record<string, string>; dataVersion: number };
    expect(Object.fromEntries(res.rows.map((r) => [r.dimensions["region"], r.measures["budget"]]))).toEqual(A.leafBudget.current.byRegion);
    expect(res.totals).toMatchObject({ budget: A.rollup.rootBudget, actual: A.rollup.rootActual });
    expect(res.dataVersion).toBeGreaterThan(0);
  });

  it("get_pacing and list_alerts", async () => {
    const pacing = (await counted("get_pacing", { filter: live(), period })) as { totals: Record<string, string> };
    expect(pacing.totals).toMatchObject({ budget: A.rollup.rootBudget, actual: A.rollup.rootActual });
    const alerts = (await counted("list_alerts", { limit: 500 })) as unknown[];
    expect(alerts).toHaveLength(Object.values(A.pacing.openAlertsByRule).reduce((n, c) => n + c, 0));
  });

  it("query_targets, list_tags, search", async () => {
    expect(((await counted("query_targets", { scopeType: "envelope" })) as unknown[]).length).toBe(A.targets.envelope);
    expect(((await counted("query_targets", { scopeType: "filter" })) as unknown[]).length).toBe(A.targets.filter);
    const tags = (await counted("list_tags")) as Array<{ name: string; count: number }>;
    expect(Object.fromEntries(tags.map((t) => [t.name, t.count]))).toEqual(A.collab.tags);
    const found = (await counted("search", { query: `type:tag ${GOLDEN_COLLAB.tags[0].name}` })) as { groups: Array<{ type: string; hits: Array<{ title: string }> }> };
    expect(found.groups.find((g) => g.type === "tag")?.hits.map((x) => x.title)).toContain(GOLDEN_COLLAB.tags[0].name);
  });

  it("get_budget, get_decision_timeline, list_threads, list_approvals", async () => {
    const thread = GOLDEN_COLLAB.threads[1];
    const envelopeId = golden.envelopeIds.get(thread.leafKey) as string;
    const b = (await counted("get_budget", { envelopeId })) as { envelope: { id: string; dimensionValues: Record<string, string> }; threads: Array<{ title: string; comments: unknown[] }> };
    expect(b.envelope.id).toBe(envelopeId);
    expect(b.threads.map((t) => [t.title, t.comments.length])).toEqual([[thread.title, thread.comments.length]]);
    const threads = (await counted("list_threads", { anchorType: "envelope", anchorId: envelopeId })) as unknown[];
    expect(threads).toHaveLength(1);
    const tl = (await counted("get_decision_timeline", { envelopeId, limit: 50 })) as { rows: unknown[] };
    expect(tl.rows.length).toBeGreaterThan(0);
    const pending = (await counted("list_approvals", { status: ["PENDING"] })) as { rows: Array<{ entityType: string; rows: number }> };
    expect(pending.rows.filter((r) => r.entityType === "bulk_change").map((r) => r.rows)).toEqual([A.pendingBulk.rows]);
  });

  it("get_closure and export_csv", async () => {
    const closure = (await counted("get_closure", { periodKey: GOLDEN_CLOSURE.periodKey })) as { closure: { status: string }; summary: { totals: Record<string, string> } };
    expect(closure.closure.status).toBe("restated");
    expect(closure.summary.totals).toMatchObject({ budget: A.closure.budget, actual: A.closure.actual });
    const csv = (await counted("export_csv", { filter: live({ field: { kind: "dimension", key: "region" }, op: "eq", value: GOLDEN_EXPORT.region }), period, measures: ["budget", "actual"] })) as { rowCount: number; downloadUrl: string; expiresInSeconds: number };
    expect(csv).toMatchObject({ rowCount: A.exports.rows, expiresInSeconds: 3600 });
    const file = [...h.store.objects.entries()].find(([uri]) => csv.downloadUrl.endsWith(uri.replace("gs://", "")))?.[1].body;
    const totals = String(file).trimEnd().split("\r\n").at(-1)?.split(",") ?? [];
    expect(totals[0]).toBe("Total");
    expect(totals).toContain(A.exports.budget);
  });

  it("the registry resource", async () => {
    const c = await h.client(tokens["planner"] as string);
    calls += 1;
    const res = await c.readResource({ uri: `budget://workspace/${golden.workspaceId}/registry` });
    await c.close();
    const body = JSON.parse(String((res.contents[0] as { text: string }).text)) as { data: { dimensions: unknown[] } };
    expect(body.data.dimensions.length).toBeGreaterThan(0);
  });

  it("wrote one mcp audit row per call and nothing else", async () => {
    expect(await fingerprint()).toEqual(before);
    expect((await mcpAudits()) - audits0).toBe(calls);
    const [row] = await owner.$queryRawUnsafe<Array<{ action: string; actor_id: string }>>(`SELECT action, actor_id::text FROM audit_event WHERE actor_type = 'mcp' AND workspace_id = $1::uuid AND action = 'mcp.query_budgets' LIMIT 1`, golden.workspaceId);
    expect(row).toEqual({ action: "mcp.query_budgets", actor_id: golden.users.finance1 });
  });
});

describe("MCP access rules", () => {
  it("a scoped caller sees only their scope", async () => {
    const res = (await tool("query_budgets", { filter: live(), groupBy: ["region"], measures: ["budget"], period }, "scoped")) as { rows: Array<{ dimensions: Record<string, string>; measures: Record<string, string> }> };
    expect(res.rows.map((r) => [r.dimensions["region"], r.measures["budget"]])).toEqual([["EMEA", A.leafBudget.current.byRegion["EMEA"]]]);
    const exported = (await tool("export_csv", { filter: live(), groupBy: ["region"], measures: ["budget"], period }, "scoped")) as { rowCount: number };
    expect(exported.rowCount).toBe(1); // a VIEWER may export, cut to EMEA
  });

  it("refuses a missing or bad token, another workspace, and a missing permission", async () => {
    expect(await h.post({}, { jsonrpc: "2.0", id: 1, method: "tools/list" })).toBe(401);
    const bad = await h.call("not-a-jwt", "list_tags", { workspaceId: golden.workspaceId });
    expect(bad).toMatchObject({ isError: true, body: { code: "UNAUTHENTICATED" } });
    const other = await h.call(tokens["finance1"] as string, "list_tags", { workspaceId: randomUUID() });
    expect(other).toMatchObject({ isError: true, body: { code: "FORBIDDEN" } });
    const approver = await h.call(tokens["approver"] as string, "query_targets", { workspaceId: golden.workspaceId });
    expect(approver.isError).toBe(false);
  });

  it("a new dimension is an MCP parameter at once (Epic 0.4)", async () => {
    const dimId = randomUUID();
    const key = `t025_${randomUUID().slice(0, 6)}`;
    await owner.$executeRawUnsafe(`INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'T-025 channel', 'ENUM', $5::uuid)`, dimId, golden.orgId, golden.workspaceId, key, golden.users.orgAdmin);
    await owner.$executeRawUnsafe(`INSERT INTO dimension_value (id, dimension_id, code, label) VALUES ($1::uuid, $2::uuid, 'retail', 'Retail')`, randomUUID(), dimId);
    const started = performance.now();
    const reg = (await tool("describe_dimensions")) as { dimensions: Array<{ key: string }> };
    expect(reg.dimensions.map((d) => d.key)).toContain(key);
    const res = (await tool("query_budgets", { filter: live({ field: { kind: "dimension", key }, op: "is_empty" }), groupBy: [key], measures: ["budget"], period })) as { totals: Record<string, string> };
    expect(new Decimal(res.totals["budget"] ?? 0).toFixed(2)).toBe(A.rollup.rootBudget);
    expect(performance.now() - started).toBeLessThan(10_000);
    await owner.$executeRawUnsafe(`DELETE FROM dimension_value WHERE dimension_id = $1::uuid`, dimId);
    await owner.$executeRawUnsafe(`DELETE FROM dimension WHERE id = $1::uuid`, dimId);
  });

  it("rate limit: 120 calls a minute per user", async () => {
    const limited = await startMcp({ limit: 2 });
    try {
      const token = await limited.mint(person("planner"));
      const args = { workspaceId: golden.workspaceId };
      expect((await limited.call(token, "list_tags", args)).isError).toBe(false);
      expect((await limited.call(token, "list_tags", args)).isError).toBe(false);
      expect(await limited.call(token, "list_tags", args)).toMatchObject({ isError: true, body: { code: "RATE_LIMITED" } });
    } finally {
      await limited.close();
    }
  });
});
