import { BigQuery } from "@google-cloud/bigquery";
import { FACT_TABLES, deleteFactMonth, factMonthTotals, factMonthsBefore, withTenant, type FactTable, type MonthTotals, type TenantContext } from "@budget/db";
import { factsPrunedBefore } from "@budget/domain";
import { Decimal } from "decimal.js";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { ObjectStore } from "../ingest/object-store.js";
import { uploadBucket } from "../ingest/object-store.js";
import { log } from "../log.js";

/**
 * Retention (docs/DATA_PLAN.md §1, D-002).
 *
 * - **Facts.** Postgres keeps the last `hotMonths` (13) months of spend, KPI and projection facts;
 *   older months live in the BigQuery replica (D-001) only. A month is deleted from Postgres only
 *   when the replica holds exactly the same rows and totals for it, table by table; months go
 *   oldest first and the job stops at the first that does not match, so what stays in Postgres is
 *   always one unbroken run of recent months. The workspace records `factsPrunedBefore`, and reads
 *   over earlier periods go to BigQuery or are refused (never a silent gap).
 * - **Raw files.** Uploaded CSVs under uploads/<workspace>/ older than the workspace's
 *   `rawFileRetentionDays` (400 by default) are deleted, except files a source still points at.
 *
 * Off unless FACT_RETENTION_ENABLED=true and a replica is configured: without BigQuery nothing is
 * ever deleted. Each deletion writes one audit_event and one outbox row.
 */
export const HOT_MONTHS = 13;
export const RAW_FILE_RETENTION_DAYS = 400;

/** What the replica holds for one workspace and month, in the same shape as Postgres. */
export interface ReplicaTotals {
  monthTotals(workspaceId: string, month: string): Promise<MonthTotals[]>;
}

/** The BigQuery replica (Datastream writes one table per Postgres table into `dataset`). */
export class BigQueryReplicaTotals implements ReplicaTotals {
  constructor(
    private readonly dataset: string,
    private readonly client: BigQuery = new BigQuery(),
  ) {}
  async monthTotals(workspaceId: string, month: string): Promise<MonthTotals[]> {
    const out: MonthTotals[] = [];
    for (const f of FACT_TABLES) {
      const [rows] = await this.client.query({
        // As factMonthTotals: every row counted, live rows summed (ADR-071; Datastream replicates superseded_at).
        query: `SELECT COUNT(*) AS n, CAST(ROUND(COALESCE(SUM(IF(superseded_at IS NULL, CAST(${f.amount} AS BIGNUMERIC), NULL)), 0), 2) AS STRING) AS amount
                FROM \`${this.dataset}.${f.table}\`
                WHERE workspace_id = @ws AND period_date >= @m AND period_date < DATE_ADD(@m, INTERVAL 1 MONTH)`,
        params: { ws: workspaceId, m: month },
        types: { ws: "STRING", m: "DATE" },
      });
      const r = (rows as Array<{ n: number | string; amount: string | null }>)[0];
      out.push({ table: f.table, rows: Number(r?.n ?? 0), amount: new Decimal(r?.amount ?? 0).toFixed(2) });
    }
    return out;
  }
}

/** The first month Postgres keeps (yyyy-MM-01): `hotMonths` back from the month `now` is in. */
export function retentionCutoff(now: Date, hotMonths = HOT_MONTHS): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - hotMonths + 1, 1));
  return d.toISOString().slice(0, 10);
}

const nextMonth = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1)).toISOString().slice(0, 10);
const same = (a: MonthTotals[], b: MonthTotals[]) =>
  a.length === b.length && a.every((x) => { const y = b.find((z) => z.table === x.table); return y !== undefined && y.rows === x.rows && new Decimal(y.amount).equals(x.amount); });

export interface FactPruneResult {
  workspaceId: string;
  pruned: Array<{ month: string; deleted: Record<string, number> }>;
  /** The first month that stayed because the replica does not match it yet (the job stops there). */
  held: { month: string; postgres: MonthTotals[]; replica: MonthTotals[] } | null;
  prunedBefore: string | null;
}

const system = (ws: { workspaceId: string; orgId: string }, what: string): TenantContext => ({ workspaceId: ws.workspaceId, orgId: ws.orgId, userId: null, isOrgAdmin: false, actorType: "system", requestId: `${what}-${ws.workspaceId}` });

async function record(tx: Prisma.TransactionClient, ctx: TenantContext, action: string, after: unknown): Promise<void> {
  await tx.$executeRaw`INSERT INTO audit_event (workspace_id, actor_id, actor_type, action, entity_type, entity_id, before, after, request_id)
    VALUES (${ctx.workspaceId}::uuid, NULL, 'system', ${action}, 'workspace', ${ctx.workspaceId}::uuid, 'null'::jsonb, ${JSON.stringify(after)}::jsonb, ${ctx.requestId})`;
  await tx.$executeRaw`INSERT INTO outbox (workspace_id, topic, payload) VALUES (${ctx.workspaceId}::uuid, ${action}, ${JSON.stringify({ workspaceId: ctx.workspaceId, ...(after as object) })}::jsonb)`;
}

/** One workspace's facts older than the cutoff, month by month, each only once the replica matches it. */
export async function pruneWorkspaceFacts(app: PrismaClient, ws: { workspaceId: string; orgId: string }, replica: ReplicaTotals, opts: { now?: Date; hotMonths?: number } = {}): Promise<FactPruneResult> {
  const ctx = system(ws, "retention");
  const cutoff = retentionCutoff(opts.now ?? new Date(), opts.hotMonths ?? HOT_MONTHS);
  const months = await withTenant(app, ctx, (tx) => factMonthsBefore(tx, ws.workspaceId, cutoff));
  const result: FactPruneResult = { workspaceId: ws.workspaceId, pruned: [], held: null, prunedBefore: null };
  for (const month of months) {
    const postgres = await withTenant(app, ctx, (tx) => factMonthTotals(tx, ws.workspaceId, month));
    const copy = await replica.monthTotals(ws.workspaceId, month);
    if (!same(postgres, copy)) {
      result.held = { month, postgres, replica: copy };
      log.warn({ workspaceId: ws.workspaceId, month, postgres, replica: copy, requestId: ctx.requestId }, "retention: replica does not match; month kept");
      break;
    }
    const deleted = await withTenant(
      app,
      ctx,
      async (tx) => {
        const counts = await deleteFactMonth(tx, ws.workspaceId, month);
        const before = nextMonth(month);
        // factsPrunedBefore only moves forward: the month after the newest month pruned.
        await tx.$executeRaw`UPDATE workspace SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{factsPrunedBefore}', to_jsonb(GREATEST(coalesce(settings->>'factsPrunedBefore', ''), ${before}::text)))
          WHERE id = ${ws.workspaceId}::uuid`;
        await tx.$executeRaw`UPDATE workspace SET settings = jsonb_set(settings, '{dataVersion}', to_jsonb(coalesce((settings->>'dataVersion')::int, 0) + 1)) WHERE id = ${ws.workspaceId}::uuid`;
        await record(tx, ctx, "facts.pruned", { month, deleted: counts, replicaTotals: copy });
        return counts;
      },
      { timeoutMs: 300_000 },
    );
    result.pruned.push({ month, deleted });
    result.prunedBefore = nextMonth(month);
  }
  if (result.pruned.length) log.info({ workspaceId: ws.workspaceId, requestId: ctx.requestId, months: result.pruned.map((p) => p.month) }, "retention: facts pruned");
  return result;
}

/** One workspace's raw uploads older than its retention, except files a source still reads. */
export async function pruneRawFiles(app: PrismaClient, ws: { workspaceId: string; orgId: string }, store: ObjectStore, opts: { now?: Date; bucket?: string } = {}): Promise<{ removed: string[]; kept: number }> {
  const ctx = system(ws, "uploads-retention");
  const now = opts.now ?? new Date();
  const { days, inUse } = await withTenant(app, ctx, async (tx) => {
    const w = await tx.workspace.findUniqueOrThrow({ where: { id: ws.workspaceId }, select: { settings: true } });
    const v = (w.settings as { rawFileRetentionDays?: unknown } | null)?.rawFileRetentionDays;
    const sources = await tx.dataSource.findMany({ where: { workspaceId: ws.workspaceId }, select: { config: true } });
    return { days: typeof v === "number" && v > 0 ? v : RAW_FILE_RETENTION_DAYS, inUse: new Set(sources.map((s) => (s.config as { uri?: unknown }).uri).filter((u): u is string => typeof u === "string")) };
  });
  const prefix = `gs://${opts.bucket ?? uploadBucket()}/uploads/${ws.workspaceId}/`;
  const before = now.getTime() - days * 86_400_000;
  const objects = await store.list(prefix);
  const due = objects.filter((o) => o.updated.getTime() < before && !inUse.has(o.uri));

  // Write audit row FIRST in its own transaction, listing the URIs
  if (due.length) {
    await withTenant(app, ctx, (tx) => record(tx, ctx, "uploads.pruned", { removed: due.map((o) => o.uri), retentionDays: days }));
  }

  // Then remove the objects; if a removal fails, log it and continue
  const failed: string[] = [];
  for (const o of due) {
    try {
      await store.remove(o.uri);
    } catch (err) {
      log.warn({ uri: o.uri, error: err instanceof Error ? err.message : String(err), requestId: ctx.requestId }, "retention: failed to remove object");
      failed.push(o.uri);
    }
  }

  // If any removals failed, write a second audit row
  if (failed.length) {
    await withTenant(app, ctx, (tx) => record(tx, ctx, "uploads.pruned", { removed: due.map((o) => o.uri), retentionDays: days, failed }));
  }

  return { removed: due.map((o) => o.uri), kept: objects.length - due.length };
}

export interface RetentionDeps {
  /** Without a replica, facts are never deleted (raw files still follow their retention). */
  replica: ReplicaTotals | null;
  store: ObjectStore;
  now?: Date;
  hotMonths?: number;
  enabled: boolean;
}

/** Every live workspace of these orgs; one failure never stops the others. */
export async function runRetention(app: PrismaClient, orgIds: readonly string[], deps: RetentionDeps): Promise<{ facts: FactPruneResult[]; files: Array<{ workspaceId: string; removed: number }> }> {
  const out = { facts: [] as FactPruneResult[], files: [] as Array<{ workspaceId: string; removed: number }> };
  if (!deps.enabled) return out;
  for (const orgId of orgIds) {
    const workspaces = await withTenant(app, { workspaceId: null, orgId, userId: null, isOrgAdmin: true, actorType: "system", requestId: `retention-scan-${orgId}` }, (tx) =>
      tx.workspace.findMany({ where: { orgId, deletedAt: null }, select: { id: true, settings: true } }),
    );
    for (const w of workspaces) {
      const ws = { workspaceId: w.id, orgId };
      try {
        if (deps.replica) out.facts.push(await pruneWorkspaceFacts(app, ws, deps.replica, { ...(deps.now ? { now: deps.now } : {}), ...(deps.hotMonths ? { hotMonths: deps.hotMonths } : {}) }));
        const files = await pruneRawFiles(app, ws, deps.store, deps.now ? { now: deps.now } : {});
        out.files.push({ workspaceId: w.id, removed: files.removed.length });
      } catch (err) {
        log.error({ err, workspaceId: w.id, orgId, prunedBefore: factsPrunedBefore(w.settings) }, "retention failed for a workspace");
      }
    }
  }
  return out;
}

/** From the environment: enabled only with FACT_RETENTION_ENABLED=true; the replica only with BIGQUERY_DATASET. */
export function retentionFromEnv(store: ObjectStore, env: NodeJS.ProcessEnv = process.env): RetentionDeps {
  const dataset = env["BIGQUERY_DATASET"];
  const months = Number(env["FACT_RETENTION_MONTHS"] ?? HOT_MONTHS);
  return { enabled: env["FACT_RETENTION_ENABLED"] === "true", replica: dataset ? new BigQueryReplicaTotals(dataset) : null, store, hotMonths: Number.isInteger(months) && months >= 13 ? months : HOT_MONTHS };
}

export type { FactTable };
