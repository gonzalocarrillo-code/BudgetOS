import "./test-support/env.js";
import { randomUUID } from "node:crypto";
import { outbox, withTenant, type TenantContext } from "@budget/db";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleExportRequested } from "./export/export.js";
import { handleIngestRequested } from "./ingest/worker.js";
import { MemoryObjectStore } from "./ingest/object-store.js";
import { MAX_ATTEMPTS, isStopping, pass, shutdown, type RunnerDeps, type RunnerHandlers } from "./local-runner.js";
import { handleInApp } from "./notify/in-app.js";
import { handleSlackEvent } from "./notify/slack.js";
import { handleRollupEvent } from "./rollup/rollup.js";
import { handleSearchEvent } from "./search-indexer/indexer.js";

/**
 * W1-2 (audit I-1, I-2, I-7, M-7): the local-runner poll loop is production for the single-org
 * deployment (ADR-065 Decision D-3). These tests exercise `pass()` directly against real handlers,
 * substituting one consumer family at a time (RunnerDeps.handlers) rather than real failures or
 * real signals, so a specific family can be made to fail (or shutdown() called) deterministically
 * while the rest run for real against Postgres.
 */

const url = (key: string) => {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set (packages/db/.env)`);
  return v;
};
const owner = new PrismaClient({ datasources: { db: { url: url("DATABASE_URL") } } });
const app = new PrismaClient({ datasources: { db: { url: url("APP_DATABASE_URL") } } });

const orgId = randomUUID();
// LOCAL_WORKSPACE_PREFIX defaults to "e2e-": every workspace the runner's default scope claims from.
const ws = randomUUID();
const slug = `e2e-w12-${ws}`;
const userId = randomUUID();
const store = new MemoryObjectStore();

const realHandlers: RunnerHandlers = {
  ingest: handleIngestRequested,
  rollup: handleRollupEvent,
  search: handleSearchEvent,
  inApp: handleInApp,
  slackNotify: handleSlackEvent,
  exportRequested: handleExportRequested,
};
const baseDeps: RunnerDeps = { app, owner, store, slack: null, maxAttempts: MAX_ATTEMPTS, handlers: realHandlers };

async function insertOutbox(topic: string, payload: unknown): Promise<string> {
  const rows = await owner.$queryRawUnsafe<Array<{ id: string }>>(`INSERT INTO outbox (workspace_id, topic, payload) VALUES ($1::uuid, $2, $3::jsonb) RETURNING id::text AS id`, ws, topic, JSON.stringify(payload));
  return rows[0]?.id as string;
}
interface Row {
  published_at: Date | null;
  attempts: number;
  last_error: string | null;
  failed_at: Date | null;
  next_attempt_at: Date | null;
}
async function outboxRow(id: string): Promise<Row> {
  const rows = await owner.$queryRawUnsafe<Row[]>(`SELECT published_at, attempts, last_error, failed_at, next_attempt_at FROM outbox WHERE id = $1::bigint`, id);
  return rows[0] as Row;
}
async function clearBackoff(id: string): Promise<void> {
  await owner.$executeRawUnsafe(`UPDATE outbox SET next_attempt_at = NULL WHERE id = $1::bigint`, id);
}
async function processed(consumer: string, id: string): Promise<boolean> {
  const rows = await owner.$queryRawUnsafe<Array<{ ok: number }>>(`SELECT 1 AS ok FROM processed_event WHERE consumer = $1 AND outbox_id = $2::bigint`, consumer, id);
  return rows.length === 1;
}
const failWith =
  (message: string): RunnerHandlers["rollup"] =>
  async () => {
    throw new Error(message);
  };

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "w1-2" } });
  await owner.workspace.create({ data: { id: ws, orgId, slug, name: "W1-2", reportingCurrency: "USD", fiscalYearStartMonth: 1 } });
  await owner.user.create({ data: { id: userId, orgId, email: `${userId}@w1-2.test`, name: "W1-2", googleSub: `g-${userId}` } });
});

afterAll(async () => {
  for (const sql of [
    `DELETE FROM processed_event WHERE outbox_id IN (SELECT id FROM outbox WHERE workspace_id = $1::uuid)`,
    `DELETE FROM outbox WHERE workspace_id = $1::uuid`,
    `DELETE FROM export_job WHERE workspace_id = $1::uuid`,
  ]) {
    await owner.$executeRawUnsafe(sql, ws);
  }
  await owner.user.deleteMany({ where: { orgId } });
  await owner.workspace.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("local-runner pass() (W1-2 done-when)", () => {
  it("a row whose roll-up handler throws stays unpublished with attempts=1 and backoff; the search consumer's work for that row still committed", async () => {
    const id = await insertOutbox("budget.changed", {});
    const deps: RunnerDeps = { ...baseDeps, handlers: { ...realHandlers, rollup: failWith("rollup: simulated failure") } };
    const n = await pass(deps);
    expect(n).toBeGreaterThan(0);
    const row = await outboxRow(id);
    expect(row.published_at).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.failed_at).toBeNull();
    expect(row.last_error).toContain("rollup: simulated failure");
    expect(row.next_attempt_at).not.toBeNull();
    expect(new Date(row.next_attempt_at as unknown as string).getTime()).toBeGreaterThan(Date.now());
    // The search family ran and recorded its dedupe row even though rollup failed (I-1: isolated tries).
    expect(await processed("search-indexer", id)).toBe(true);
    // The failed family's dedupe row rolled back with its transaction, so a redelivery re-applies it.
    expect(await processed("rollup-worker", id)).toBe(false);
  });

  it("8 failures dead-letter the row (failed_at); it is then excluded even once its backoff has passed", async () => {
    const id = await insertOutbox("budget.changed", {});
    const deps: RunnerDeps = { ...baseDeps, handlers: { ...realHandlers, rollup: failWith("rollup: still down") } };
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await clearBackoff(id); // simulate the backoff window passing without waiting minutes in a unit test
      await pass(deps);
    }
    const row = await outboxRow(id);
    expect(row.attempts).toBe(MAX_ATTEMPTS);
    expect(row.failed_at).not.toBeNull();
    await clearBackoff(id);
    await pass(deps);
    const after = await outboxRow(id);
    expect(after.attempts).toBe(MAX_ATTEMPTS); // claimLocalOutbox excludes failed_at rows outright
  });

  it("an export.requested row produces a completed export_job (and is published)", async () => {
    const jobId = randomUUID();
    const tenant: TenantContext = { workspaceId: ws, orgId, userId, isOrgAdmin: false, actorType: "user", requestId: `w12-${jobId}` };
    await withTenant(app, tenant, async (tx) => {
      await tx.exportJob.create({ data: { id: jobId, workspaceId: ws, kind: "csv", query: { workspaceId: ws, period: { kind: "range", start: "2026-01-01", end: "2026-12-31" } }, filename: "w12-export", createdBy: userId } });
      await outbox(tx, { workspaceId: ws, topic: "export.requested", payload: { jobId } });
    });
    const [row] = await owner.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id::text AS id FROM outbox WHERE workspace_id = $1::uuid AND topic = 'export.requested' ORDER BY id DESC LIMIT 1`, ws);
    const outboxId = row?.id as string;
    const n = await pass(baseDeps);
    expect(n).toBeGreaterThan(0);
    const job = await owner.exportJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job).toMatchObject({ status: "done", rowCount: 0 });
    expect(store.objects.has(`gs://budget-os-uploads/exports/${ws}/${jobId}.csv`)).toBe(true);
    expect((await outboxRow(outboxId)).published_at).not.toBeNull();
  });

  it("SIGTERM mid-pass: the in-flight row finishes, the next row in the batch is left untouched", async () => {
    const id1 = await insertOutbox("budget.changed", {});
    const id2 = await insertOutbox("budget.changed", {});
    let seen = 0;
    const signalingSearch: RunnerHandlers["search"] = async (prisma, body, today) => {
      seen += 1;
      if (seen === 1) shutdown(); // stands in for a real SIGTERM arriving while the first row is mid-flight
      return realHandlers.search(prisma, body, today);
    };
    const deps: RunnerDeps = { ...baseDeps, handlers: { ...realHandlers, search: signalingSearch } };
    const n = await pass(deps);
    expect(n).toBe(2); // both rows were claimed in the one SELECT
    expect(isStopping()).toBe(true);
    const row1 = await outboxRow(id1);
    const row2 = await outboxRow(id2);
    expect(row1.published_at).not.toBeNull(); // the in-flight row ran to completion
    expect(row2.published_at).toBeNull(); // never started
    expect(row2.attempts).toBe(0);
    expect(await processed("search-indexer", id2)).toBe(false);
  });
});
