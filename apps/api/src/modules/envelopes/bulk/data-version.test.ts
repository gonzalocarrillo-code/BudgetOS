import { randomUUID } from "node:crypto";
import { goldenPlan } from "@budget/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGolden, type GoldenResult } from "../../../seed/golden.js";
import { cleanupGolden } from "../../../test-support/golden-cleanup.js";
import { appDb as appDbClient, ownerDb, startHarness, type Harness } from "../../../test-support/harness.js";

/**
 * W3-8 (audit I-14, ADR-0084) done-when: a bulk commit no longer blocks a concurrent single edit,
 * and the data version `/query` keys its cache on still moves with every write, in commit order.
 *
 * The bulk commit is held open at its very end (a deferred trigger on its `bulk_change` row waits
 * on an advisory lock this test holds), after every statement the old code ran, including the
 * `bumpDataVersion` that locked the workspace row until commit. While it is held, a single draft
 * edit in the same workspace must complete.
 */

const owner = ownerDb();
const app = appDbClient();
let h: Harness;
let golden: GoldenResult;
const slug = `w38-${randomUUID().slice(0, 8)}`;
const plan = goldenPlan();
const HOLD_KEY = 0x57380000 + Math.floor(Math.random() * 0xffff);
const fn = `w38_hold_${slug.replace(/-/g, "_")}`;
type Json = Record<string, unknown>;

async function as(persona: string, method: "GET" | "POST" | "PATCH", url: string, body?: unknown) {
  const token = await h.mint({ sub: `ip-${persona}`, email: `${persona.toLowerCase()}@${slug}.golden.test` }, { googleSub: `golden-${slug}-${persona}` });
  return h.call(method, url, token, { headers: { "x-workspace-id": golden.workspaceId }, ...(body === undefined ? {} : { body }) });
}
const id = (key: string) => golden.envelopeIds.get(key) as string;
const leafKeys = (prefix: string) => plan.filter((e) => e.level === 4 && e.key.startsWith(prefix)).map((e) => e.key);

/** The data version `/query` answers with (and keys its cache on). */
async function queryVersion(): Promise<number> {
  const res = await as("planner", "POST", `/api/v1/workspaces/${golden.workspaceId}/query`, { workspaceId: golden.workspaceId, period: { kind: "relative", preset: "current_year" }, groupBy: ["region"], measures: ["budget"] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return Number(res.body["dataVersion"]);
}

/** Resolves once some backend is waiting on HOLD_KEY's advisory lock (the bulk commit, at commit). */
async function bulkIsHeld(): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const rows = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND ((classid::bigint << 32) | objid::bigint) = $1::bigint`,
      HOLD_KEY,
    );
    if (Number(rows[0]?.n ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the bulk commit never reached its held commit");
}

const timeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} still waiting after ${ms} ms`)), ms))]);

beforeAll(async () => {
  golden = await seedGolden(app, owner, { slug });
  h = await startHarness();
  // Fires at COMMIT (deferred), after every statement of the bulk commit, and only for this workspace.
  await owner.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${HOLD_KEY}::bigint); RETURN NULL; END $$`);
  await owner.$executeRawUnsafe(
    `CREATE CONSTRAINT TRIGGER ${fn} AFTER INSERT ON bulk_change DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.workspace_id = '${golden.workspaceId}'::uuid) EXECUTE FUNCTION ${fn}()`,
  );
}, 180_000);

afterAll(async () => {
  await owner.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON bulk_change`);
  await owner.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
  await h?.close();
  if (golden?.created) await cleanupGolden(owner, golden);
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("W3-8: the data version is not a per-workspace write lock", () => {
  it("a single edit completes while a bulk commit in the same workspace is still open, and the version moves for both, in commit order", async () => {
    const bulkIds = leafKeys("LATAM/BR/meta/awareness").map(id);
    const single = id(leafKeys("LATAM/MX/meta/conversion")[0] as string);
    expect(bulkIds.length).toBeGreaterThan(0);

    const v0 = await queryVersion();
    const p = await as("planner", "POST", "/api/v1/envelopes/bulk", { workspaceId: golden.workspaceId, selection: { envelopeIds: bulkIds }, operation: { op: "pct", pct: 1 }, rationale: "w3-8 hold" });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const head = (await as("planner", "GET", `/api/v1/envelopes/${single}`)).body as { currentVersionId: string | null; draftVersionId: string | null };

    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let holding!: () => void;
    const held = new Promise<void>((r) => (holding = r));
    const hold = owner.$transaction(
      async (t) => {
        await t.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${HOLD_KEY}::bigint)`);
        holding();
        await released;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    await held;
    let bulkDone = false;
    let v1: number | undefined;
    const bulk = as("planner", "POST", `/api/v1/envelopes/bulk/${String(p.body["previewId"])}/commit`).finally(() => (bulkDone = true));
    try {
      await bulkIsHeld();
      const started = performance.now();
      const edit = await timeout(as("planner", "PATCH", `/api/v1/envelopes/${single}/draft`, { amount: "123.45", basedOnVersionId: head.draftVersionId ?? head.currentVersionId }), 10_000, "the single edit");
      const waitedMs = performance.now() - started;
      expect(edit.status, JSON.stringify(edit.body)).toBe(200);
      expect(bulkDone, "the bulk commit is still open while the single edit completed").toBe(false);
      expect(waitedMs).toBeLessThan(5_000);
      v1 = await queryVersion();
      expect(v1, "the single edit moved the version while the bulk commit was open").toBeGreaterThan(v0);
      process.stdout.write(`w3-8: single edit took ${waitedMs.toFixed(0)} ms while the bulk commit was held open\n`);
    } finally {
      release();
    }
    await hold;
    const c = (await bulk) as { status: number; body: Json };
    expect(c.status, JSON.stringify(c.body)).toBe(201);

    // The single edit committed first, the bulk commit last: each moved the version, and the bulk's
    // (whose outbox row has the lower id) is the newer version — a cache entry built between the
    // two commits is never served after the bulk commit.
    expect(v1).toBeDefined();
    expect(await queryVersion()).toBeGreaterThan(v1 ?? Number.POSITIVE_INFINITY);
  }, 60_000);

  it("every committed write moves the version /query reads; a rolled-back write does not", async () => {
    const env = id(leafKeys("LATAM/MX/meta/conversion")[1] as string);
    const before = await queryVersion();
    const head = (await as("planner", "GET", `/api/v1/envelopes/${env}`)).body as { currentVersionId: string | null; draftVersionId: string | null };
    const ok = await as("planner", "PATCH", `/api/v1/envelopes/${env}/draft`, { amount: "10.00", basedOnVersionId: head.draftVersionId ?? head.currentVersionId });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const after = await queryVersion();
    expect(after).toBe(before + 1);
    const stale = await as("planner", "PATCH", `/api/v1/envelopes/${env}/draft`, { amount: "11.00", basedOnVersionId: head.draftVersionId ?? head.currentVersionId });
    expect(stale.status).toBe(409);
    expect(await queryVersion()).toBe(after);
  });
});
