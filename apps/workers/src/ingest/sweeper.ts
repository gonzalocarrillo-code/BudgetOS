import { newId } from "@budget/domain";
import { audit, localActiveOrgs, outbox, withTenant, type LocalScope, type TenantContext } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { log } from "../log.js";
import { failIngestRun } from "./pipeline.js";

/**
 * W3-4 (audit I-9): a `running` ingest_run or export_job whose worker died leaves the row stuck —
 * `queueRun` then refuses a new run ("A run is already running") and the export's requester has no
 * way back in. The sweeper fails any `running` row whose lease has expired (no heartbeat for
 * RUN_LEASE_MS, apps/workers/src/run-lease.ts), with the same audit_event + outbox a normal failure
 * writes, and re-queues the ingest run exactly once (`summary.requeuedFrom`; a run that already
 * carries that key was itself a requeue and is not requeued again). Exports are never requeued —
 * the requester starts a new one (docs/runbooks/exports.md).
 *
 * Safe to run on every pass: each table's work is one query against its `(status) WHERE status =
 * 'running'` partial index, and the per-row guard (`status = 'running' AND lease_until < now`,
 * re-checked at the write) means a run whose lease the pipeline just renewed is left alone even if
 * it was in the stale list a moment earlier.
 */
export interface SweepResult {
  ingestFailed: number;
  ingestRequeued: number;
  exportsFailed: number;
}

function ctxFor(workspaceId: string, orgId: string, label: string): TenantContext {
  return { workspaceId, orgId, userId: null, isOrgAdmin: false, actorType: "system", requestId: `sweeper-${label}` };
}

async function sweepIngestRuns(app: PrismaClient, ws: { id: string; orgId: string }, now: Date): Promise<{ failed: number; requeued: number }> {
  const ctx = ctxFor(ws.id, ws.orgId, `ingest-${ws.id}`);
  const stale = await withTenant(app, ctx, (tx) => tx.ingestRun.findMany({ where: { status: "running", leaseUntil: { lt: now } }, select: { id: true, sourceId: true, summary: true } }));
  let failed = 0;
  let requeued = 0;
  for (const run of stale) {
    const outcome = await withTenant(app, ctx, async (tx) => {
      const ok = await failIngestRun(tx, { workspaceId: ws.id, sourceId: run.sourceId, runId: run.id, error: "lease expired", requestId: ctx.requestId, guard: { status: "running", leaseBefore: now } });
      if (!ok) return { swept: false, requeued: false }; // lease was renewed, or another pass already handled it
      const requested = (run.summary ?? {}) as { restatementOf?: string; mode?: string; requeuedFrom?: string };
      if (requested.requeuedFrom) return { swept: true, requeued: false }; // already a retry of an earlier stale run: not retried again
      const newRunId = newId();
      const summary = { ...(requested.restatementOf ? { restatementOf: requested.restatementOf } : {}), ...(requested.mode ? { mode: requested.mode } : {}), requeuedFrom: run.id };
      await tx.ingestRun.create({ data: { id: newRunId, sourceId: run.sourceId, status: "queued", summary } });
      await audit(tx, { workspaceId: ws.id, actorId: null, actorType: "system", action: "ingest.run.queued", entityType: "ingest_run", entityId: newRunId, after: { sourceId: run.sourceId, requeuedFrom: run.id }, requestId: ctx.requestId });
      await outbox(tx, { workspaceId: ws.id, topic: "ingest.requested", payload: { runId: newRunId, sourceId: run.sourceId } });
      return { swept: true, requeued: true };
    });
    if (outcome.swept) failed += 1;
    if (outcome.requeued) requeued += 1;
  }
  return { failed, requeued };
}

async function sweepExportJobs(app: PrismaClient, ws: { id: string; orgId: string }, now: Date): Promise<number> {
  const ctx = ctxFor(ws.id, ws.orgId, `export-${ws.id}`);
  const stale = await withTenant(app, ctx, (tx) => tx.exportJob.findMany({ where: { status: "running", leaseUntil: { lt: now } }, select: { id: true, kind: true, createdBy: true } }));
  let failed = 0;
  for (const job of stale) {
    const ok = await withTenant(app, ctx, async (tx) => {
      const n = await tx.exportJob.updateMany({ where: { id: job.id, status: "running", leaseUntil: { lt: now } }, data: { status: "failed", error: "lease expired", completedAt: new Date() } });
      if (n.count === 0) return false;
      const after = { status: "failed" as const, kind: job.kind, rowCount: null, error: "lease expired" };
      await audit(tx, { workspaceId: ws.id, actorId: null, actorType: "system", action: "export.failed", entityType: "export_job", entityId: job.id, after, requestId: ctx.requestId });
      await outbox(tx, { workspaceId: ws.id, topic: "export.completed", payload: { jobId: job.id, requestedBy: job.createdBy, ...after } });
      return true;
    });
    if (ok) failed += 1;
  }
  return failed;
}

/** Every active workspace of `orgIds`: one failure never stops the others (same shape as runRetention). */
export async function runSweeper(app: PrismaClient, orgIds: readonly string[], now: Date = new Date()): Promise<SweepResult> {
  const out: SweepResult = { ingestFailed: 0, ingestRequeued: 0, exportsFailed: 0 };
  for (const orgId of orgIds) {
    const workspaces = await withTenant(app, { workspaceId: null, orgId, userId: null, isOrgAdmin: true, actorType: "system", requestId: `sweeper-scan-${orgId}` }, (tx) =>
      tx.workspace.findMany({ where: { orgId, deletedAt: null }, select: { id: true } }),
    );
    for (const w of workspaces) {
      const ws = { id: w.id, orgId };
      try {
        const ingest = await sweepIngestRuns(app, ws, now);
        out.ingestFailed += ingest.failed;
        out.ingestRequeued += ingest.requeued;
        out.exportsFailed += await sweepExportJobs(app, ws, now);
      } catch (err) {
        log.error({ err, workspaceId: w.id, orgId }, "lease sweeper failed for a workspace");
      }
    }
  }
  return out;
}

/** The local runner's one call: discovers its orgs as budget_publisher, then sweeps as budget_app. */
export async function sweeperPass(app: PrismaClient, publisher: PrismaClient, scope: LocalScope): Promise<void> {
  const orgIds = await localActiveOrgs(publisher, scope);
  if (orgIds.length === 0) return;
  const result = await runSweeper(app, orgIds);
  if (result.ingestFailed || result.exportsFailed) log.info(result, "lease sweeper pass finished");
}
