import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { topicsFor } from "@budget/domain";
import {
  claimLocalOutbox,
  localActiveOrgs,
  localAllOrgs,
  localOrgsPendingPurge,
  localWorkspacesForReindex,
  markLocalFailure,
  markLocalPublished,
  type LocalOutboxRow,
  type LocalScope,
} from "@budget/db";
import { PrismaClient } from "@prisma/client";
import { handleIngestRequested } from "./ingest/worker.js";
import { sweeperPass } from "./ingest/sweeper.js";
import { handleRollupEvent } from "./rollup/rollup.js";
import { handleInApp } from "./notify/in-app.js";
import { handleSlackEvent, slackConfigWarnings, slackFromEnv, type SlackClient } from "./notify/slack.js";
import { handleExportRequested } from "./export/export.js";
import { objectStoreFromEnv, uploadBucket, type ObjectStore } from "./ingest/object-store.js";
import { idempotencyPass } from "./idempotency/sweep.js";
import { log } from "./log.js";
import { purgeDueWorkspaces } from "./purge/purge.js";
import { retentionFromEnv, runRetention } from "./retention/retention.js";
import { checkSnapshotIntegrity } from "./integrity/snapshots.js";
import { runPacing } from "./pacing/main.js";
import { handleSearchEvent, reindexWorkspace } from "./search-indexer/indexer.js";

/**
 * budgetos-worker (ADR-0080): an always-on Cloud Run service running this loop. It polls the outbox
 * for the ingest, roll-up, notify and export topics (@budget/domain topicsFor) in its own
 * workspaces — every workspace of the org of the workspace slugged LOCAL_ORG_FROM (the local stack:
 * "local"), else slug prefix LOCAL_WORKSPACE_PREFIX ("e2e-" by default, the Playwright stack) —
 * never another deployment's rows. Each row's consumer families run in-process against the real
 * push handlers, each isolated in its own try (I-1): a row is marked published only once every
 * family that applies to it has succeeded; a row with a failure keeps its unpublished rows, backs
 * off (`next_attempt_at`, exponential, capped) and dead-letters after OUTBOX_MAX_ATTEMPTS attempts
 * (`failed_at`), listed and replayed per docs/runbooks/worker.md.
 *
 * Decision D-3 (2026-10-05, ADR-010, ADR-0080): this poll loop IS the production design for the
 * single-org deployment, not a stand-in for a Pub/Sub path that happens not to be deployed yet. The
 * at-least-once publisher/push path (outbox-publisher.ts, consumer.ts's handleOnce under a Pub/Sub
 * push subscription) stays available and typechecked for the multi-tenant design (spec §19) but is
 * not wired into deploy.yml; nothing here should be read as "temporary". LISTEN_HOST=0.0.0.0 binds
 * Cloud Run's port; PACING_EVERY_MS evaluates the pacing rules of the org on that schedule (off by
 * default, as locally).
 *
 * Two Prisma connections (W2-3, audit S-2 — no owner role in this request path):
 * - `publisher` (`PUBLISHER_DATABASE_URL`, role `budget_publisher`, ADR-010): claims, marks and
 *   dead-letters outbox rows, and runs every discovery query that finds the runner's own orgs and
 *   workspaces (`packages/db/src/runner.ts`) — never DATABASE_URL, never the owner role.
 *   `budget_publisher` holds exactly the column-level grants those queries need (migration
 *   `20261010040000_publisher_discovery_grants`); it is NOBYPASSRLS like every other login role.
 * - `app` (`APP_DATABASE_URL`, role `budget_app`): runs the real consumer handlers inside
 *   `withTenant()`, same as the API.
 */

export const MAX_ATTEMPTS = Number(process.env["OUTBOX_MAX_ATTEMPTS"] ?? 8);
const CLAIM_LIMIT = 50;

const prefix = process.env["LOCAL_WORKSPACE_PREFIX"] ?? "e2e-";
const orgFrom = process.env["LOCAL_ORG_FROM"] ?? null;
const scope: LocalScope = { prefix, orgFrom };
/** The workers' subscriptions, from the one list in @budget/domain (spec §19). approval.changed goes to both roll-up and notify. */
const INGEST: string[] = topicsFor("ingest");
const ROLLUP: string[] = topicsFor("rollup");
const NOTIFY: string[] = topicsFor("notify");
const EXPORT: string[] = topicsFor("export");
const TOPICS = [...new Set([...INGEST, ...ROLLUP, ...NOTIFY, ...EXPORT])];
const slack = slackFromEnv();
// No owner role in this request path (audit S-2): the poll loop claims, marks and discovers its
// workspaces as budget_publisher (ADR-010), least-privilege and NOBYPASSRLS, never DATABASE_URL.
// Fail fast rather than silently falling back: a worker that quietly ran as the owner would be the
// exact mistake this item closes.
const publisherDatabaseUrl = process.env["PUBLISHER_DATABASE_URL"];
if (!publisherDatabaseUrl) {
  throw new Error("PUBLISHER_DATABASE_URL is required (the worker no longer runs its poll loop as the owner role)");
}
const publisher = new PrismaClient({ datasources: { db: { url: publisherDatabaseUrl } } });
const app = new PrismaClient({ datasources: { db: { url: process.env["APP_DATABASE_URL"] ?? "" } } });
const store = objectStoreFromEnv();

/**
 * SIGTERM/SIGINT (M-7): set once, checked between rows and between passes, never cleared. The
 * current row always finishes; nothing new is claimed after. The health server and its Prisma
 * clients stay open through this: shutdown() only flips the flag, main()'s loop does the draining.
 */
let stopping = false;
export function shutdown(): void {
  stopping = true;
}
export function isStopping(): boolean {
  return stopping;
}

async function ensureBucket(): Promise<void> {
  const emulator = process.env["GCS_EMULATOR_HOST"];
  if (!emulator) return;
  const res = await fetch(`${emulator}/storage/v1/b?project=budget-os-local`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: uploadBucket() }) });
  if (!res.ok && res.status !== 409) throw new Error(`creating bucket ${uploadBucket()}: ${res.status}`);
}

/** Every consumer family the loop can run for a row, swappable in tests so one family can be made to fail while the rest run for real. */
export interface RunnerHandlers {
  ingest: typeof handleIngestRequested;
  rollup: typeof handleRollupEvent;
  search: typeof handleSearchEvent;
  inApp: typeof handleInApp;
  slackNotify: typeof handleSlackEvent;
  exportRequested: typeof handleExportRequested;
}

export interface RunnerDeps {
  app: PrismaClient;
  publisher: PrismaClient;
  store: ObjectStore;
  slack: SlackClient | null;
  maxAttempts: number;
  handlers: RunnerHandlers;
}

const defaultHandlers: RunnerHandlers = {
  ingest: handleIngestRequested,
  rollup: handleRollupEvent,
  search: handleSearchEvent,
  inApp: handleInApp,
  slackNotify: handleSlackEvent,
  exportRequested: handleExportRequested,
};

/** The real dependencies main() runs against; a test builds its own RunnerDeps instead of mutating this one. */
export const defaultDeps: RunnerDeps = { app, publisher, store, slack, maxAttempts: MAX_ATTEMPTS, handlers: defaultHandlers };

const push = (row: LocalOutboxRow, subscription: string) => ({
  message: { data: Buffer.from(JSON.stringify(row.payload)).toString("base64"), attributes: { outboxId: row.id, workspaceId: row.workspaceId, orgId: row.orgId, topic: row.topic }, messageId: `local-${row.id}` },
  subscription: `projects/local/subscriptions/${subscription}`,
});

/**
 * Runs one outbox row's consumer families, each in its own try (I-1): an ingest, roll-up or notify
 * failure never skips the others. Consumers that already succeeded on an earlier attempt are not
 * re-run on this redelivery — handleOnce's processed_event dedupe (consumer.ts) returns "duplicate"
 * and does nothing, per consumer, keyed on this row's outbox id, which never changes across
 * retries. A row is published once every family that applies to it has succeeded this pass (which,
 * thanks to that dedupe, includes families that merely succeeded on a prior pass).
 */
async function runRow(deps: RunnerDeps, row: LocalOutboxRow): Promise<void> {
  const failures: Array<{ consumer: string; error: unknown }> = [];
  const attempt = async (consumer: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (error) {
      failures.push({ consumer, error });
      log.error({ err: error, outboxId: row.id, workspaceId: row.workspaceId, topic: row.topic, consumer }, "local worker consumer failed");
    }
  };
  if (INGEST.includes(row.topic)) await attempt("ingest", () => deps.handlers.ingest(deps.app, { prisma: deps.app, store: deps.store, reportBucket: uploadBucket() }, push(row, "ingest-worker")));
  if (ROLLUP.includes(row.topic)) await attempt("rollup", () => deps.handlers.rollup(deps.app, push(row, "rollup-worker")));
  // The search indexer takes every topic (spec §12.1) and decides what each one touched.
  await attempt("search", () => deps.handlers.search(deps.app, push(row, "search-indexer")));
  if (NOTIFY.includes(row.topic)) {
    await attempt("notify-in-app", () => deps.handlers.inApp(deps.app, push(row, "notify-worker")));
    await attempt("notify-slack", () => deps.handlers.slackNotify(deps.app, deps.slack, push(row, "notify-worker")));
  }
  if (EXPORT.includes(row.topic)) await attempt("export", () => deps.handlers.exportRequested(deps.app, deps.store, push(row, "export-worker")));

  if (failures.length === 0) {
    await markLocalPublished(deps.publisher, row.id);
    return;
  }
  const first = failures[0] as { consumer: string; error: unknown };
  const message = first.error instanceof Error ? first.error.message : String(first.error);
  await markLocalFailure(deps.publisher, row.id, message, { maxAttempts: deps.maxAttempts });
  log.error(
    { outboxId: row.id, workspaceId: row.workspaceId, topic: row.topic, attempts: row.attempts + 1, failedConsumers: failures.map((f) => f.consumer) },
    "outbox row failed; consumers that succeeded are kept (processed_event dedupe), the rest retry with backoff",
  );
}

/**
 * One poll: claims up to CLAIM_LIMIT claimable rows (unpublished, not dead-lettered, past their
 * backoff) and runs each. Checked for shutdown before every row, so a signal mid-pass finishes the
 * row in flight and leaves the rest of the batch — and the next poll — unclaimed.
 */
export async function pass(deps: RunnerDeps = defaultDeps): Promise<number> {
  const rows = await claimLocalOutbox(deps.publisher, scope, TOPICS, CLAIM_LIMIT);
  for (const row of rows) {
    if (stopping) break;
    await runRow(deps, row);
  }
  return rows.length;
}

// ADR-052: deleted workspaces past their retention window are purged, checked once a minute.
let lastPurge = 0;
async function purgePass(): Promise<void> {
  if (Date.now() - lastPurge < 60_000) return;
  lastPurge = Date.now();
  const orgs = await localOrgsPendingPurge(publisher, scope);
  if (orgs.length) await purgeDueWorkspaces(app, orgs);
}

// W3-11 (audit I-37): keeps month partitions of spend_fact, kpi_fact, projection_fact and
// audit_event six months ahead, once a day, as a backstop to migrate-time and the pacing/ingest
// calls that already extend them — if those ever stalled, a write past the furthest existing
// partition would fail with "no partition of relation found for row" (the DEFAULT partitions this
// item also adds mean that never happens, but writes outside the default are unindexed by month, so
// the proactive pass still matters). Runs as `app` (budget_app), which already holds EXECUTE on the
// SECURITY DEFINER ensure_fact_partitions (migration 20260924080000; W3-11 confirmed the grant still
// stands) — no new grant needed.
let lastPartitionPass = 0;
async function partitionPass(): Promise<void> {
  if (Date.now() - lastPartitionPass < 86_400_000) return;
  lastPartitionPass = Date.now();
  await app.$executeRaw`SELECT ensure_fact_partitions(CURRENT_DATE, 6)`;
  log.info("partition pass finished");
}

// D-002: fact and raw-file retention, once a day, only with FACT_RETENTION_ENABLED=true (and facts
// only with a BigQuery replica, BIGQUERY_DATASET). Off by default: nothing is deleted locally.
let lastRetention = 0;
async function retentionPass(): Promise<void> {
  const deps = retentionFromEnv(store);
  if (!deps.enabled || Date.now() - lastRetention < 86_400_000) return;
  lastRetention = Date.now();
  const orgs = await localActiveOrgs(publisher, scope);
  if (orgs.length) await runRetention(app, orgs, deps);
}

// D-015: the snapshot integrity check, once a week (SNAPSHOT_INTEGRITY=off disables it). Read-only.
let lastIntegrity = 0;
async function integrityPass(): Promise<void> {
  if (process.env["SNAPSHOT_INTEGRITY"] === "off" || Date.now() - lastIntegrity < 7 * 86_400_000) return;
  lastIntegrity = Date.now();
  const orgs = await localAllOrgs(publisher, scope);
  if (orgs.length) await checkSnapshotIntegrity(app, orgs);
}

// Search (R11-001): workspaces whose index is empty are indexed on the first pass (a deployment
// started before the worker indexed, or a restored database); every workspace once a day.
let lastFullReindex = Date.now(); // startup indexes only the empty ones; the full pass comes a day later
let checkedEmpty = false;
async function reindexPass(): Promise<void> {
  const full = Date.now() - lastFullReindex > 86_400_000;
  if (!full && checkedEmpty) return;
  const rows = await localWorkspacesForReindex(publisher, scope);
  const due = rows.filter((r) => full || r.empty);
  for (const w of due) await reindexWorkspace(app, { workspaceId: w.id, orgId: w.orgId });
  checkedEmpty = true;
  if (full) lastFullReindex = Date.now();
  if (due.length) log.info({ workspaces: due.length, full }, "search reindex pass finished");
}

// Pacing (spec §11): the org's rules, every PACING_EVERY_MS (900000 = the spec's 15 minutes).
let lastPacing = 0;
async function pacingPass(): Promise<void> {
  const every = Number(process.env["PACING_EVERY_MS"] ?? 0);
  if (!every || Date.now() - lastPacing < every) return;
  lastPacing = Date.now();
  const orgs = await localActiveOrgs(publisher, scope);
  if (orgs.length === 0) return;
  const now = new Date();
  const result = await runPacing(app, orgs, now.toISOString().slice(0, 10), now);
  log.info({ workspaces: result.length }, "pacing pass finished");
}

/** Cloud Run's probe only (M-7, audit M-7): every other path is 404, not an implicit "ok". */
export function healthRequestListener(req: IncomingMessage, res: ServerResponse): void {
  if (req.url === "/health") {
    res.writeHead(200).end("ok");
  } else {
    res.writeHead(404).end();
  }
}

async function main(): Promise<void> {
  await ensureBucket();
  const port = Number(process.env["PORT"] ?? 4799);
  const server = createServer(healthRequestListener).listen(port, process.env["LISTEN_HOST"] ?? "127.0.0.1");
  log.info({ port, prefix, orgFrom, slack: slack !== null, maxAttempts: MAX_ATTEMPTS }, "local runner up");
  for (const warning of slackConfigWarnings()) log.warn(warning);
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      log.info({ signal: sig }, "local runner draining: finishing the current row, then stopping (health stays up meanwhile)");
      shutdown();
    });
  }

  while (!isStopping()) {
    await reindexPass().catch((err: unknown) => log.error({ err }, "search reindex pass failed"));
    if (isStopping()) break;
    await pacingPass().catch((err: unknown) => log.error({ err }, "pacing pass failed"));
    if (isStopping()) break;
    await integrityPass().catch((err: unknown) => log.error({ err }, "local integrity pass failed"));
    if (isStopping()) break;
    await partitionPass().catch((err: unknown) => log.error({ err }, "partition pass failed"));
    if (isStopping()) break;
    await retentionPass().catch((err: unknown) => log.error({ err }, "local retention pass failed"));
    if (isStopping()) break;
    await purgePass().catch((err: unknown) => log.error({ err }, "local purge pass failed"));
    if (isStopping()) break;
    await sweeperPass(app, publisher, scope).catch((err: unknown) => log.error({ err }, "ingest/export lease sweeper pass failed"));
    if (isStopping()) break;
    await idempotencyPass(app, publisher, scope).catch((err: unknown) => log.error({ err }, "idempotency key sweep failed"));
    if (isStopping()) break;
    const n = await pass().catch((err: unknown) => (log.error({ err }, "local runner pass failed"), 0));
    if (n === 0 && !isStopping()) await new Promise((r) => setTimeout(r, 1000));
  }
  log.info("local runner drained; closing Prisma connections");
  server.close();
  await Promise.all([publisher.$disconnect(), app.$disconnect()]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    log.fatal({ err: error }, "local runner crashed");
    process.exit(1);
  });
}
