import { LIVE_LEAVES } from "@budget/domain";
import { upsertSearchDocuments, withTenant, type TenantContext } from "@budget/db";
import { BUILDERS, handleRollupEvent, handleSearchEvent, rebuildWorkspace } from "@budget/workers";
import type { PrismaClient } from "@prisma/client";
import type { GoldenResult } from "../seed/golden.js";
import type { Harness } from "../test-support/harness.js";

/** Appendix C targets the load job asserts (plan Appendix C, spec §21). */
export const TARGETS = {
  gridQueryP95Ms: 400,
  searchP95Ms: 150,
  inlineEditP95Ms: 300,
  bulkCommit10kMs: 10_000,
  rollupLagP95Ms: 5_000,
  searchLagP95Ms: 5_000,
} as const;

export const p95 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] as number) : NaN;
};
const now = () => performance.now();

const system = (g: GoldenResult, requestId: string): TenantContext => ({ workspaceId: g.workspaceId, orgId: g.orgId, userId: null, isOrgAdmin: false, actorType: "system", requestId });

/** The search index through the real document builders, in batches (reindexWorkspace holds a whole type in one transaction). */
export async function indexAll(app: PrismaClient, owner: PrismaClient, g: GoldenResult, log: (s: string) => void): Promise<number> {
  const ctx = { workspaceId: g.workspaceId, orgId: g.orgId, today: new Date().toISOString().slice(0, 10) };
  let total = 0;
  const run = async (type: keyof typeof BUILDERS, ids: string[] | null) =>
    withTenant(
      app,
      system(g, `load-index-${type}`),
      async (tx) => {
        const built = await BUILDERS[type](tx, ctx, ids);
        for (let i = 0; i < built.upserts.length; i += 1000) await upsertSearchDocuments(tx, built.upserts.slice(i, i + 1000));
        total += built.upserts.length;
      },
      { timeoutMs: 600_000 },
    );
  for (const type of ["target", "approval_request", "alert", "tag", "dimension_value"] as const) await run(type, null);
  const ids = async (sql: string) => (await owner.$queryRawUnsafe<Array<{ id: string }>>(sql, g.workspaceId)).map((r) => r.id);
  const envelopes = await ids(`SELECT id::text AS id FROM envelope WHERE workspace_id = $1::uuid ORDER BY id`);
  for (let i = 0; i < envelopes.length; i += 5000) await run("envelope", envelopes.slice(i, i + 5000));
  log(`load: indexed ${envelopes.length} envelopes`);
  const comments = await ids(`SELECT c.id::text AS id FROM comment c JOIN thread t ON t.id = c.thread_id WHERE t.workspace_id = $1::uuid ORDER BY c.id`);
  for (let i = 0; i < comments.length; i += 10_000) {
    await run("comment", comments.slice(i, i + 10_000));
    if ((i / 10_000) % 20 === 0) log(`load: indexed comments ${i + 10_000} / ${comments.length}`);
  }
  await owner.$executeRawUnsafe(`ANALYZE search_document`);
  return total;
}

export async function rebuildRollups(app: PrismaClient, g: GoldenResult): Promise<Record<string, number>> {
  return rebuildWorkspace(app, { workspaceId: g.workspaceId, orgId: g.orgId });
}

interface Ctx {
  h: Harness;
  g: GoldenResult;
  slug: string;
  owner: PrismaClient;
  app: PrismaClient;
  log: (s: string) => void;
}

const token = (c: Ctx, persona: string) => c.h.mint({ sub: `ip-${persona}`, email: `${persona.toLowerCase()}@${c.slug}.golden.test` }, { googleSub: `golden-${c.slug}-${persona}`, exp: "4h" });

async function timed(c: Ctx, persona: string, method: "GET" | "POST" | "PATCH", url: string, body?: unknown) {
  const t = await token(c, persona);
  const t0 = now();
  const res = await c.h.call(method, url, t, { headers: { "x-workspace-id": c.g.workspaceId }, ...(body === undefined ? {} : { body }) });
  const ms = now() - t0;
  if (res.status >= 400) throw new Error(`${method} ${url} → ${res.status}: ${res.text.slice(0, 300)}`);
  return { ms, body: res.body };
}

/** Explorer-shaped queries: tree levels, a deep expand, a leaf page, the pivot, a shard filter. */
export async function gridQueries(c: Ctx, iterations: number): Promise<Record<string, number>> {
  const ws = c.g.workspaceId;
  const eq = (key: string, value: string) => ({ field: { kind: "dimension", key }, op: "eq", value });
  const base = { workspaceId: ws, period: { kind: "relative", preset: "current_year" }, measures: ["budget", "actual", "projected", "pace_index"] };
  const leaves = (...more: unknown[]) => ({ logic: "and", children: [...LIVE_LEAVES, ...more] });
  const scenarios: Record<string, unknown> = {
    tree_root: { ...base, groupBy: ["region"], filter: leaves() },
    tree_country: { ...base, groupBy: ["country"], filter: leaves(eq("region", "LATAM")) },
    tree_deep: { ...base, groupBy: ["audience"], filter: leaves(eq("region", "LATAM"), eq("country", "BR"), eq("platform", "meta"), eq("objective", "awareness")) },
    leaf_page: { ...base, filter: leaves(eq("country", "BR")), sort: [{ key: "budget", dir: "desc" }], limit: 200 },
    pivot: { ...base, groupBy: ["country", "platform"], filter: leaves(), limit: 1000 },
    shard_filter: { ...base, filter: leaves(eq("load_shard", "s0100")), limit: 200 },
  };
  const out: Record<string, number> = {};
  const all: number[] = [];
  for (const [name, body] of Object.entries(scenarios)) {
    for (let i = 0; i < 2; i += 1) await timed(c, "planner", "POST", `/api/v1/workspaces/${ws}/query`, body); // warm
    const ms: number[] = [];
    for (let i = 0; i < iterations; i += 1) ms.push((await timed(c, "planner", "POST", `/api/v1/workspaces/${ws}/query`, body)).ms);
    out[name] = Math.round(p95(ms));
    all.push(...ms);
  }
  out["all"] = Math.round(p95(all));
  return out;
}

export async function searches(c: Ctx, iterations: number): Promise<Record<string, number>> {
  const ws = c.g.workspaceId;
  const queries = ["BR meta awareness", "country:BR type:envelope", "status:approved platform:meta", "Black Friday", "lookalike reforecast", "load_shard:s0100", "tag:q4-push"];
  const out: Record<string, number> = {};
  const all: number[] = [];
  for (const q of queries) {
    const url = `/api/v1/workspaces/${ws}/search?q=${encodeURIComponent(q)}&limit=10`;
    for (let i = 0; i < 2; i += 1) await timed(c, "planner", "GET", url);
    const ms: number[] = [];
    for (let i = 0; i < iterations; i += 1) ms.push((await timed(c, "planner", "GET", url)).ms);
    out[q] = Math.round(p95(ms));
    all.push(...ms);
  }
  out["all"] = Math.round(p95(all));
  return out;
}

/** Leaves of the copies, for the write measurements (never the golden rows other checks read). */
async function copiedLeaves(c: Ctx, n: number, offset = 0, fromEnd = false): Promise<Array<{ id: string; head: string; amount: string }>> {
  return c.owner.$queryRawUnsafe(
    `SELECT e.id::text AS id, coalesce(e.draft_version_id, e.current_version_id)::text AS head, v.amount::text AS amount
       FROM envelope e JOIN envelope_version v ON v.id = e.current_version_id
      WHERE e.workspace_id = $1::uuid AND e.dimension_values ? 'load_shard' AND e.status = 'APPROVED'
        AND NOT EXISTS (SELECT 1 FROM envelope k WHERE k.parent_id = e.id AND k.status <> 'ARCHIVED')
      ORDER BY e.id ${fromEnd ? "DESC" : "ASC"} OFFSET $3 LIMIT $2`,
    c.g.workspaceId,
    n,
    offset,
  );
}

export async function inlineEdits(c: Ctx, n: number): Promise<number> {
  const ms: number[] = [];
  for (const leaf of await copiedLeaves(c, n, 0)) {
    const amount = (Number(leaf.amount) * 1.01).toFixed(2);
    ms.push((await timed(c, "planner", "PATCH", `/api/v1/envelopes/${leaf.id}/draft`, { amount, basedOnVersionId: leaf.head })).ms);
  }
  return Math.round(p95(ms));
}

export async function bulkCommit(c: Ctx, rows: number): Promise<{ previewMs: number; commitMs: number; rows: number }> {
  // Past the rows the inline edits used; a small (local) run takes what there is and says so.
  const leaves = await copiedLeaves(c, rows, 1000);
  if (leaves.length < rows) throw new Error(`bulk: only ${leaves.length} copied leaves past the first 1,000 (the spec scale has ~100k)`);
  const preview = await timed(c, "planner", "POST", "/api/v1/envelopes/bulk", { workspaceId: c.g.workspaceId, selection: { envelopeIds: leaves.map((l) => l.id) }, operation: { op: "pct", pct: 1 }, rationale: "load test bulk" });
  const commit = await timed(c, "planner", "POST", `/api/v1/envelopes/bulk/${String(preview.body["previewId"])}/commit`);
  return { previewMs: Math.round(preview.ms), commitMs: Math.round(commit.ms), rows: leaves.length };
}

/**
 * Derived-data lag: a small change goes through the API (draft, submit; the minor-change policy
 * approves it), then its outbox events go to the roll-up and search handlers as Pub/Sub would push
 * them. Lag = commit start → handler done.
 */
export async function lags(c: Ctx, n: number): Promise<{ rollupP95Ms: number; searchP95Ms: number }> {
  const rollup: number[] = [];
  const search: number[] = [];
  // The seed's own events were already applied by the full rebuild and re-index: only this loop's count.
  await c.owner.$executeRawUnsafe(`UPDATE outbox SET published_at = now() WHERE workspace_id = $1::uuid AND published_at IS NULL`, c.g.workspaceId);
  // The last leaves: never the ones the inline edits (first) or the bulk commit (next 10k) touched.
  for (const leaf of await copiedLeaves(c, n, 0, true)) {
    const t0 = now();
    const draft = await timed(c, "planner", "PATCH", `/api/v1/envelopes/${leaf.id}/draft`, { amount: (Number(leaf.amount) * 1.005).toFixed(2), basedOnVersionId: leaf.head });
    const submitted = await timed(c, "planner", "POST", `/api/v1/envelopes/${leaf.id}/submit`, { versionId: draft.body["id"] });
    if (submitted.body["autoApproved"] !== true) throw new Error(`lag: the change was not auto-approved (${JSON.stringify(submitted.body).slice(0, 200)})`);
    const rows = await c.owner.$queryRawUnsafe<Array<{ id: string; topic: string; payload: unknown }>>(
      `SELECT id::text AS id, topic, payload FROM outbox WHERE workspace_id = $1::uuid AND published_at IS NULL ORDER BY id`,
      c.g.workspaceId,
    );
    const push = (r: (typeof rows)[number], sub: string) => ({ message: { data: Buffer.from(JSON.stringify(r.payload)).toString("base64"), attributes: { outboxId: r.id, workspaceId: c.g.workspaceId, orgId: c.g.orgId, topic: r.topic }, messageId: `load-${sub}-${r.id}` }, subscription: `projects/load/subscriptions/${sub}` });
    const budget = rows.filter((r) => r.topic === "budget.changed");
    const t1 = now();
    for (const r of budget) await handleRollupEvent(c.app, push(r, "rollup"));
    rollup.push(now() - t1 + (t1 - t0));
    const t2 = now();
    for (const r of rows) await handleSearchEvent(c.app, push(r, "search"));
    search.push(now() - t2 + (t1 - t0));
    await c.owner.$executeRawUnsafe(`UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[])`, rows.map((r) => r.id));
  }
  return { rollupP95Ms: Math.round(p95(rollup)), searchP95Ms: Math.round(p95(search)) };
}
