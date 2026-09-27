import { createServer } from "node:http";
import { PrismaClient } from "@prisma/client";
import { handleIngestRequested } from "./ingest/worker.js";
import { handleRollupEvent } from "./rollup/rollup.js";
import { objectStoreFromEnv, uploadBucket } from "./ingest/object-store.js";
import { log } from "./log.js";

/**
 * Local stand-in for Pub/Sub + the ingest and roll-up workers (T-032, ADR-038), for the Playwright
 * stack and the local stack only. It polls the outbox for their topics in local workspaces (slug
 * prefix LOCAL_WORKSPACE_PREFIX, "e2e-" by default — never another test's rows) and hands each to
 * the real push handler in-process, then marks that row published. The roll-up worker keeps the
 * cache the Explorer's tree reads. It also creates the uploads bucket in the GCS emulator.
 * Deployed environments use the outbox publisher and Cloud Run push.
 */
const prefix = process.env["LOCAL_WORKSPACE_PREFIX"] ?? "e2e-";
/** ingest.requested → the ingest worker; the rest → the roll-up worker (its subscriptions, spec §19). */
const TOPICS = ["ingest.requested", "budget.changed", "facts.loaded", "registry.changed", "naming.changed"];
const owner = new PrismaClient({ datasources: { db: { url: process.env["DATABASE_URL"] ?? "" } } });
const app = new PrismaClient({ datasources: { db: { url: process.env["APP_DATABASE_URL"] ?? "" } } });
const store = objectStoreFromEnv();

async function ensureBucket(): Promise<void> {
  const emulator = process.env["GCS_EMULATOR_HOST"];
  if (!emulator) return;
  const res = await fetch(`${emulator}/storage/v1/b?project=budget-os-local`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: uploadBucket() }) });
  if (!res.ok && res.status !== 409) throw new Error(`creating bucket ${uploadBucket()}: ${res.status}`);
}

async function pass(): Promise<number> {
  const rows = await owner.$queryRawUnsafe<Array<{ id: string; workspace_id: string; org_id: string; topic: string; payload: unknown }>>(
    `SELECT o.id::text AS id, o.workspace_id::text AS workspace_id, w.org_id::text AS org_id, o.topic, o.payload
       FROM outbox o JOIN workspace w ON w.id = o.workspace_id
      WHERE o.topic = ANY($2::text[]) AND o.published_at IS NULL AND w.slug LIKE $1
      ORDER BY w.created_at DESC, o.id LIMIT 50`,
    `${prefix}%`,
    TOPICS,
  );
  // Newest workspace first: a workspace a crashed run left behind never starves the live one.
  for (const row of rows) {
    const ingest = row.topic === "ingest.requested";
    const body = {
      message: { data: Buffer.from(JSON.stringify(row.payload)).toString("base64"), attributes: { outboxId: row.id, workspaceId: row.workspace_id, orgId: row.org_id, topic: row.topic }, messageId: `local-${row.id}` },
      subscription: `projects/local/subscriptions/${ingest ? "ingest-worker" : "rollup-worker"}`,
    };
    try {
      const result = ingest ? await handleIngestRequested(app, { prisma: app, store, reportBucket: uploadBucket() }, body) : await handleRollupEvent(app, body);
      log.info({ outboxId: row.id, workspaceId: row.workspace_id, topic: row.topic, result }, ingest ? "local ingest run" : "local roll-up refresh");
    } catch (err) {
      log.error({ err, outboxId: row.id, workspaceId: row.workspace_id, topic: row.topic }, "local worker run failed");
    }
    await owner.$executeRawUnsafe(`UPDATE outbox SET published_at = now() WHERE id = $1::bigint`, row.id);
  }
  return rows.length;
}

await ensureBucket();
const port = Number(process.env["PORT"] ?? 4799);
createServer((_, res) => void res.writeHead(200).end("ok")).listen(port, "127.0.0.1");
log.info({ port, prefix }, "local runner up");
for (;;) {
  const n = await pass().catch((err: unknown) => (log.error({ err }, "local runner pass failed"), 0));
  if (n === 0) await new Promise((r) => setTimeout(r, 1000));
}
