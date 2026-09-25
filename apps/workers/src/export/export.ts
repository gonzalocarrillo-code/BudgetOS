import { DomainError, EXPORT_MAX_ROWS, ExportRequested, QueryRequest, resolvePeriod } from "@budget/domain";
import { audit, envelopePaths, outbox, plannerOptions, withTenant, type TenantContext, type Tx } from "@budget/db";
import { compileQuery, compileTotals, pageOf } from "@budget/query-planner";
import type { PrismaClient } from "@prisma/client";
import { decodePush, handleOnce } from "../consumer.js";
import { uploadBucket, type ObjectStore } from "../ingest/object-store.js";
import { log } from "../log.js";
import { buildTable, type ExportTable } from "./table.js";
import { toCsv, toXlsx } from "./writers.js";

/**
 * export-worker (spec §19, plan §6.2, ADR-017). `export.requested` claims the queued job under the
 * consumer's dedupe row; the export then runs in one repeatable-read transaction, so every page
 * and the totals row see the same snapshot. The file goes to `gs://<uploads>/exports/<ws>/<job>.<ext>`
 * and the job becomes `done` (or `failed`) with one audit_event and one `export.completed` outbox row.
 * A job left `running` by a crashed worker is not retried (the requester starts a new one).
 */

export const EXPORT_CONSUMER = "export-worker";
const PAGE = 1000;
const CONTENT_TYPE = { csv: "text/csv; charset=utf-8", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } as const;
type Row = Record<string, unknown>;

export const exportUri = (workspaceId: string, jobId: string, kind: "csv" | "xlsx") => `gs://${uploadBucket()}/exports/${workspaceId}/${jobId}.${kind}`;

/** All pages of the query plus its totals, laid out as the export table. */
export async function exportTable(tx: Tx, tenant: { workspaceId: string; orgId: string }, raw: unknown, today: string) {
  const parsed = QueryRequest.parse(raw);
  const q: QueryRequest = { ...parsed, limit: PAGE };
  delete q.cursor;
  const ws = await tx.workspace.findUniqueOrThrow({ where: { id: tenant.workspaceId }, select: { name: true, reportingCurrency: true, fiscalYearStartMonth: true, settings: true } });
  const period = resolvePeriod(q.period, today, ws.fiscalYearStartMonth);
  const opts = await plannerOptions(tx, tenant, q.targets, period);
  const rows: Row[] = [];
  let cursor: string | null = null;
  do {
    const page: QueryRequest = cursor ? { ...q, cursor } : q;
    const c = compileQuery(page, period, today, opts);
    const got = pageOf(c, await tx.$queryRawUnsafe<Row[]>(c.sql, ...c.values), PAGE);
    rows.push(...got.rows);
    if (rows.length > EXPORT_MAX_ROWS) throw new DomainError("VALIDATION", `The export has more than ${EXPORT_MAX_ROWS} rows; narrow the filter`, { max: EXPORT_MAX_ROWS });
    cursor = got.nextCursor;
  } while (cursor);
  const t = compileTotals(q, period, today, opts);
  const [totals] = await tx.$queryRawUnsafe<Row[]>(t.sql, ...t.values);
  const flat = q.groupBy.length === 0;
  const paths = flat ? await envelopePaths(tx, rows.map((r) => String(r["envelope_id"]))) : new Map<string, string[]>();
  const dimensions = await tx.dimension.findMany({
    where: { orgId: tenant.orgId, OR: [{ workspaceId: null }, { workspaceId: tenant.workspaceId }] },
    orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
    select: { key: true, label: true },
  });
  const table = buildTable(q, rows, totals ?? {}, { dimensions, paths, reportingCurrency: ws.reportingCurrency });
  const dataVersion = Number((ws.settings as { dataVersion?: number } | null)?.dataVersion ?? 0);
  return { q, table, period, workspaceName: ws.name, dataVersion };
}

async function encode(kind: "csv" | "xlsx", table: ExportTable, meta: Parameters<typeof toXlsx>[1]): Promise<Buffer> {
  return kind === "csv" ? toCsv(table) : toXlsx(table, meta);
}

export interface ExportResult {
  outcome: "done" | "failed";
  jobId: string;
  rowCount: number | null;
  objectUri: string | null;
  error: string | null;
}

/** Runs a claimed (`running`) job to `done` or `failed`. */
export async function runExport(prisma: PrismaClient, store: ObjectStore, tenant: { workspaceId: string; orgId: string }, jobId: string, today = new Date().toISOString().slice(0, 10)): Promise<ExportResult> {
  const ctx: TenantContext = { ...tenant, userId: null, isOrgAdmin: false, actorType: "system", requestId: `${EXPORT_CONSUMER}-${jobId}` };
  let result: ExportResult;
  try {
    const job = await withTenant(prisma, ctx, (tx) => tx.exportJob.findUniqueOrThrow({ where: { id: jobId } }));
    if (job.kind !== "csv" && job.kind !== "xlsx") throw new DomainError("UNAVAILABLE", `${job.kind} export is not configured`);
    const kind = job.kind;
    const built = await withTenant(prisma, ctx, (tx) => exportTable(tx, tenant, job.query, today), { isolation: "RepeatableRead", timeoutMs: 300_000 });
    const body = await encode(kind, built.table, { workspaceName: built.workspaceName, period: built.period, generatedAt: new Date().toISOString(), dataVersion: built.dataVersion, query: built.q });
    const uri = exportUri(tenant.workspaceId, jobId, kind);
    await store.write(uri, body, CONTENT_TYPE[kind]);
    result = { outcome: "done", jobId, rowCount: built.table.rows.length, objectUri: uri, error: null };
  } catch (error) {
    const known = error instanceof DomainError;
    const message = known ? error.message : "The export failed; start a new one";
    log[known ? "warn" : "error"]({ err: error, jobId, workspaceId: tenant.workspaceId, requestId: ctx.requestId }, "export failed");
    result = { outcome: "failed", jobId, rowCount: null, objectUri: null, error: message };
  }
  await withTenant(prisma, ctx, async (tx) => {
    const job = await tx.exportJob.update({
      where: { id: jobId },
      data: { status: result.outcome, rowCount: result.rowCount, objectUri: result.objectUri, error: result.error, completedAt: new Date() },
    });
    const after = { status: result.outcome, kind: job.kind, rowCount: result.rowCount, error: result.error };
    await audit(tx, { workspaceId: tenant.workspaceId, actorId: null, actorType: "system", action: `export.${result.outcome}`, entityType: "export_job", entityId: jobId, after, requestId: ctx.requestId });
    await outbox(tx, { workspaceId: tenant.workspaceId, topic: "export.completed", payload: { jobId, requestedBy: job.createdBy, ...after } });
  });
  return result;
}

/** Push handler for `export.requested`. */
export async function handleExportRequested(prisma: PrismaClient, store: ObjectStore, body: unknown, today?: string): Promise<{ outcome: "duplicate" | "not_queued" } | ExportResult> {
  const event = decodePush(body);
  const { jobId } = ExportRequested.parse(event.payload);
  let claimed = false;
  const outcome = await handleOnce(prisma, EXPORT_CONSUMER, event, async (tx) => {
    const n = await tx.exportJob.updateMany({ where: { id: jobId, status: "queued" }, data: { status: "running", startedAt: new Date() } });
    claimed = n.count === 1;
  });
  if (outcome === "duplicate") return { outcome: "duplicate" };
  if (!claimed) return { outcome: "not_queued" };
  return runExport(prisma, store, { workspaceId: event.workspaceId, orgId: event.orgId }, jobId, today);
}
