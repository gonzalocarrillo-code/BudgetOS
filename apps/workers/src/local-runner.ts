import { createServer } from "node:http";
import { PrismaClient } from "@prisma/client";
import { handleIngestRequested } from "./ingest/worker.js";
import { objectStoreFromEnv, uploadBucket } from "./ingest/object-store.js";
import { log } from "./log.js";

/**
 * Local stand-in for Pub/Sub + the ingest worker (T-032), for the Playwright stack and
 * `e2e:stack` only. It polls the outbox for `ingest.requested` rows of local workspaces (slug
 * prefix LOCAL_WORKSPACE_PREFIX, "e2e-" by default — never another test's rows) and hands each to
 * the real push handler in-process, then marks that row published. It also creates the uploads
 * bucket in the GCS emulator. Deployed environments use the outbox publisher and Cloud Run push.
 */
const prefix = process.env["LOCAL_WORKSPACE_PREFIX"] ?? "e2e-";
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
  const rows = await owner.$queryRawUnsafe<Array<{ id: string; workspace_id: string; org_id: string; payload: unknown }>>(
    `SELECT o.id::text AS id, o.workspace_id::text AS workspace_id, w.org_id::text AS org_id, o.payload
       FROM outbox o JOIN workspace w ON w.id = o.workspace_id
      WHERE o.topic = 'ingest.requested' AND o.published_at IS NULL AND w.slug LIKE $1
      ORDER BY o.id LIMIT 10`,
    `${prefix}%`,
  );
  for (const row of rows) {
    const body = {
      message: { data: Buffer.from(JSON.stringify(row.payload)).toString("base64"), attributes: { outboxId: row.id, workspaceId: row.workspace_id, orgId: row.org_id, topic: "ingest.requested" }, messageId: `local-${row.id}` },
      subscription: "projects/local/subscriptions/ingest-worker",
    };
    try {
      const result = await handleIngestRequested(app, { prisma: app, store, reportBucket: uploadBucket() }, body);
      log.info({ outboxId: row.id, workspaceId: row.workspace_id, result }, "local ingest run");
    } catch (err) {
      log.error({ err, outboxId: row.id, workspaceId: row.workspace_id }, "local ingest run failed");
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
