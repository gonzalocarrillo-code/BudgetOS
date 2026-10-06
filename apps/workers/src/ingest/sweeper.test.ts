import "../test-support/env.js";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteWorkspaceForTests } from "../purge/purge.js";
import { runSweeper } from "./sweeper.js";

/**
 * W3-4 (audit I-9): a `running` ingest_run or export_job whose worker died is stuck forever without
 * a sweeper. runSweeper fails a `running` row whose lease has expired, with the same audit_event +
 * outbox a normal failure writes, and re-queues an ingest run exactly once. A row with a fresh
 * heartbeat is left alone.
 */

const url = (key: string) => {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set (packages/db/.env)`);
  return v;
};
const owner = new PrismaClient({ datasources: { db: { url: url("DATABASE_URL") } } });
const app = new PrismaClient({ datasources: { db: { url: url("APP_DATABASE_URL") } } });

const orgId = randomUUID();
const ws = randomUUID();
const userId = randomUUID();
const sourceId = randomUUID();

const count = async (sql: string, ...args: unknown[]) => Number((await owner.$queryRawUnsafe<Array<{ n: bigint }>>(sql, ...args))[0]?.n ?? 0);

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "w34" } });
  await owner.workspace.create({ data: { id: ws, orgId, slug: `w34-${ws}`, name: "W3-4", reportingCurrency: "USD" } });
  await owner.user.create({ data: { id: userId, orgId, email: `${userId}@w34.test`, name: "W3-4", googleSub: `g-${userId}` } });
  await owner.dataSource.create({ data: { id: sourceId, workspaceId: ws, kind: "csv", name: "W3-4 CSV", config: { kind: "csv", uri: `gs://w34-uploads/uploads/${ws}/spend.csv` }, mapping: { kind: "spend", columns: { COUNTRY: { dimension: "country" } } } } });
});

afterAll(async () => {
  // W3-11 (audit I-32): deletes every row that FKs to this workspace (and the workspace row
  // itself), in the same order `purgeWorkspace` validates against production.
  await deleteWorkspaceForTests(owner, ws);
  await owner.user.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

/** `leaseAgoMs` > 0 sets a lease already in the past (stale); < 0 sets one still in the future (fresh); null leaves it unset. */
async function queueIngest(status: string, leaseAgoMs: number | null, summary: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  const leaseUntil = leaseAgoMs === null ? null : new Date(now.getTime() - leaseAgoMs);
  await owner.ingestRun.create({ data: { id, sourceId, status, startedAt: now, leaseUntil, heartbeatAt: leaseUntil, summary: summary as never } });
  return id;
}

async function queueExport(status: string, leaseAgoMs: number | null): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  const leaseUntil = leaseAgoMs === null ? null : new Date(now.getTime() - leaseAgoMs);
  await owner.exportJob.create({
    data: { id, workspaceId: ws, kind: "csv", status, query: { workspaceId: ws, period: { kind: "range", start: "2026-01-01", end: "2026-01-31" } }, filename: "w34", createdBy: userId, startedAt: now, leaseUntil },
  });
  return id;
}

describe("runSweeper: ingest runs (W3-4, audit I-9)", () => {
  it("fails a running run whose lease expired, with one audit_event + one outbox row, and re-queues ingest exactly once", async () => {
    const runId = await queueIngest("running", 60_000); // lease expired a minute ago
    const result = await runSweeper(app, [orgId]);
    expect(result.ingestFailed).toBeGreaterThanOrEqual(1);
    expect(result.ingestRequeued).toBeGreaterThanOrEqual(1);

    const run = await owner.ingestRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("failed");
    expect((run.summary as { error: string }).error).toBe("lease expired");
    expect(await count(`SELECT count(*) AS n FROM audit_event WHERE entity_id = $1::uuid AND action = 'ingest.run.failed'`, runId)).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM outbox WHERE topic = 'ingest.failed' AND payload->>'runId' = $1`, runId)).toBe(1);

    const requeued = await owner.$queryRawUnsafe<Array<{ id: string; status: string }>>(`SELECT id::text, status FROM ingest_run WHERE source_id = $1::uuid AND summary->>'requeuedFrom' = $2`, sourceId, runId);
    expect(requeued).toHaveLength(1);
    expect(requeued[0]?.status).toBe("queued");
    expect(await count(`SELECT count(*) AS n FROM audit_event WHERE entity_id = $1::uuid AND action = 'ingest.run.queued'`, requeued[0]?.id)).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM outbox WHERE topic = 'ingest.requested' AND payload->>'runId' = $1`, requeued[0]?.id)).toBe(1);
  });

  it("does not requeue a run that is itself already a requeue (no infinite retries)", async () => {
    const original = await queueIngest("failed", null);
    const runId = await queueIngest("running", 60_000, { requeuedFrom: original });
    const result = await runSweeper(app, [orgId]);
    expect(result.ingestFailed).toBeGreaterThanOrEqual(1);

    const run = await owner.ingestRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("failed");
    expect(await count(`SELECT count(*) AS n FROM ingest_run WHERE source_id = $1::uuid AND summary->>'requeuedFrom' = $2`, sourceId, runId)).toBe(0);
  });

  it("a restatement run that goes stale is re-queued as a restatement of the same closure", async () => {
    const closureId = randomUUID();
    const runId = await queueIngest("running", 60_000, { restatementOf: closureId, mode: "full" });
    await runSweeper(app, [orgId]);
    const [requeued] = await owner.$queryRawUnsafe<Array<{ summary: { restatementOf?: string; mode?: string } }>>(`SELECT summary FROM ingest_run WHERE source_id = $1::uuid AND summary->>'requeuedFrom' = $2`, sourceId, runId);
    expect(requeued?.summary).toMatchObject({ restatementOf: closureId, mode: "full" });
  });

  it("leaves a running run alone while its heartbeat is fresh", async () => {
    const runId = await queueIngest("running", -5 * 60_000); // lease is 5 minutes in the future
    await runSweeper(app, [orgId]);
    const run = await owner.ingestRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("running");
    expect(await count(`SELECT count(*) AS n FROM audit_event WHERE entity_id = $1::uuid`, runId)).toBe(0);
  });
});

describe("runSweeper: export jobs (W3-4, audit I-9)", () => {
  it("fails an export whose lease expired, with one audit_event + one outbox row, and never re-queues it", async () => {
    const jobId = await queueExport("running", 60_000);
    const result = await runSweeper(app, [orgId]);
    expect(result.exportsFailed).toBeGreaterThanOrEqual(1);

    const job = await owner.exportJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job).toMatchObject({ status: "failed", error: "lease expired" });
    expect(await count(`SELECT count(*) AS n FROM audit_event WHERE entity_id = $1::uuid AND action = 'export.failed'`, jobId)).toBe(1);
    const [row] = await owner.$queryRawUnsafe<Array<{ payload: Record<string, unknown> }>>(`SELECT payload FROM outbox WHERE topic = 'export.completed' AND payload->>'jobId' = $1`, jobId);
    expect(row?.payload).toMatchObject({ jobId, requestedBy: userId, status: "failed", kind: "csv", error: "lease expired" });
    expect(await count(`SELECT count(*) AS n FROM outbox WHERE topic = 'export.requested'`)).toBe(0);
  });

  it("leaves a running export alone while its heartbeat is fresh", async () => {
    const jobId = await queueExport("running", -5 * 60_000);
    await runSweeper(app, [orgId]);
    const job = await owner.exportJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("running");
  });
});
