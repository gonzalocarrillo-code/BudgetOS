import { IngestRequested } from "@budget/domain";
import type { PrismaClient } from "@prisma/client";
import { decodePush, handleOnce } from "../consumer.js";
import { runIngest, type IngestDeps, type IngestResult } from "./pipeline.js";

export const INGEST_CONSUMER = "ingest-worker";

/**
 * Push handler for `ingest.requested` (ADR-011). The dedupe row and the queued → running claim
 * commit together, so a redelivered message never starts a second run; the pipeline itself runs
 * after that commit in its own batch transactions. A run left `running` by a crashed worker is
 * not retried automatically (the run keeps its status for an operator to re-queue).
 */
export async function handleIngestRequested(prisma: PrismaClient, deps: IngestDeps, body: unknown): Promise<{ outcome: "duplicate" | "not_queued" } | IngestResult> {
  const event = decodePush(body);
  const { runId } = IngestRequested.parse(event.payload);
  let claimed = false;
  const outcome = await handleOnce(prisma, INGEST_CONSUMER, event, async (tx) => {
    const n = await tx.ingestRun.updateMany({ where: { id: runId, status: "queued" }, data: { status: "running", startedAt: new Date() } });
    claimed = n.count === 1;
  });
  if (outcome === "duplicate") return { outcome: "duplicate" };
  if (!claimed) return { outcome: "not_queued" };
  return runIngest(deps, { workspaceId: event.workspaceId, orgId: event.orgId }, runId);
}
