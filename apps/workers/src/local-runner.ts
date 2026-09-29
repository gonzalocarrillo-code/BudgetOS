import { createServer } from "node:http";
import { PrismaClient } from "@prisma/client";
import { handleIngestRequested } from "./ingest/worker.js";
import { handleRollupEvent } from "./rollup/rollup.js";
import { handleInApp } from "./notify/in-app.js";
import { handleSlackEvent, slackFromEnv } from "./notify/slack.js";
import { objectStoreFromEnv, uploadBucket } from "./ingest/object-store.js";
import { log } from "./log.js";
import { purgeDueWorkspaces } from "./purge/purge.js";
import { retentionFromEnv, runRetention } from "./retention/retention.js";

/**
 * Local stand-in for Pub/Sub + the ingest, roll-up and notify workers (T-032, ADR-038), for the
 * Playwright stack and the local stack only. It polls the outbox for their topics in its own
 * workspaces — every workspace of the org of the workspace slugged LOCAL_ORG_FROM (the local
 * stack: "local", so a workspace created in the app is served too), else slug prefix
 * LOCAL_WORKSPACE_PREFIX ("e2e-" by default) — never another test's rows. Each row goes to the real
 * push handlers in-process, then is marked published. The roll-up worker keeps the cache the
 * Explorer's tree reads; the notify worker writes in-app notifications and posts to Slack when
 * SLACK_BOT_TOKEN is set. It also creates the uploads bucket in the GCS emulator.
 * Deployed environments use the outbox publisher and Cloud Run push.
 */
const prefix = process.env["LOCAL_WORKSPACE_PREFIX"] ?? "e2e-";
const orgFrom = process.env["LOCAL_ORG_FROM"] ?? null;
/** The workers' subscriptions (spec §19): ingest, roll-up, notify. approval.changed goes to both roll-up and notify. */
const INGEST = ["ingest.requested"];
const ROLLUP = ["budget.changed", "facts.loaded", "registry.changed", "naming.changed", "approval.changed", "period.closed", "period.restated"];
const NOTIFY = ["alert.triggered", "alert.changed", "approval.changed", "thread.changed", "slack.test"];
const TOPICS = [...new Set([...INGEST, ...ROLLUP, ...NOTIFY])];
const slack = slackFromEnv();
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
      WHERE o.topic = ANY($2::text[]) AND o.published_at IS NULL
        AND ($3::text IS NULL AND w.slug LIKE $1 OR w.org_id = (SELECT org_id FROM workspace WHERE slug = $3::text))
        -- ADR-052: an archived or deleted workspace is frozen; its events wait, unapplied.
        AND w.status = 'ACTIVE' AND w.deleted_at IS NULL
      ORDER BY w.created_at DESC, o.id LIMIT 50`,
    `${prefix}%`,
    TOPICS,
    orgFrom,
  );
  // Newest workspace first: a workspace a crashed run left behind never starves the live one.
  for (const row of rows) {
    const push = (subscription: string) => ({
      message: { data: Buffer.from(JSON.stringify(row.payload)).toString("base64"), attributes: { outboxId: row.id, workspaceId: row.workspace_id, orgId: row.org_id, topic: row.topic }, messageId: `local-${row.id}` },
      subscription: `projects/local/subscriptions/${subscription}`,
    });
    try {
      if (INGEST.includes(row.topic)) {
        const result = await handleIngestRequested(app, { prisma: app, store, reportBucket: uploadBucket() }, push("ingest-worker"));
        log.info({ outboxId: row.id, workspaceId: row.workspace_id, topic: row.topic, result }, "local ingest run");
      }
      if (ROLLUP.includes(row.topic)) {
        const result = await handleRollupEvent(app, push("rollup-worker"));
        log.info({ outboxId: row.id, workspaceId: row.workspace_id, topic: row.topic, result }, "local roll-up refresh");
      }
      if (NOTIFY.includes(row.topic)) {
        await handleInApp(app, push("notify-worker"));
        const result = await handleSlackEvent(app, slack, push("notify-worker"));
        if (result.posted.length) log.info({ outboxId: row.id, topic: row.topic, posted: result.posted.length }, "local Slack delivery");
      }
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
log.info({ port, prefix, orgFrom, slack: slack !== null }, "local runner up");
// ADR-052: deleted workspaces past their retention window are purged, checked once a minute.
let lastPurge = 0;
async function purgePass(): Promise<void> {
  if (Date.now() - lastPurge < 60_000) return;
  lastPurge = Date.now();
  const orgs = await owner.$queryRawUnsafe<Array<{ org_id: string }>>(
    `SELECT DISTINCT org_id::text FROM workspace WHERE deleted_at IS NOT NULL AND purged_at IS NULL AND ($2::text IS NULL AND slug LIKE $1 OR org_id = (SELECT org_id FROM workspace WHERE slug = $2::text))`,
    `${prefix}%`,
    orgFrom,
  );
  if (orgs.length) await purgeDueWorkspaces(app, orgs.map((o) => o.org_id));
}

// D-002: fact and raw-file retention, once a day, only with FACT_RETENTION_ENABLED=true (and facts
// only with a BigQuery replica, BIGQUERY_DATASET). Off by default: nothing is deleted locally.
let lastRetention = 0;
async function retentionPass(): Promise<void> {
  const deps = retentionFromEnv(store);
  if (!deps.enabled || Date.now() - lastRetention < 86_400_000) return;
  lastRetention = Date.now();
  const orgs = await owner.$queryRawUnsafe<Array<{ org_id: string }>>(
    `SELECT DISTINCT org_id::text FROM workspace WHERE deleted_at IS NULL AND ($2::text IS NULL AND slug LIKE $1 OR org_id = (SELECT org_id FROM workspace WHERE slug = $2::text))`,
    `${prefix}%`,
    orgFrom,
  );
  if (orgs.length) await runRetention(app, orgs.map((o) => o.org_id), deps);
}

for (;;) {
  await retentionPass().catch((err: unknown) => log.error({ err }, "local retention pass failed"));
  await purgePass().catch((err: unknown) => log.error({ err }, "local purge pass failed"));
  const n = await pass().catch((err: unknown) => (log.error({ err }, "local runner pass failed"), 0));
  if (n === 0) await new Promise((r) => setTimeout(r, 1000));
}
