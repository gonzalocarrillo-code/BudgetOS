import { SourceConfig, SourceMapping } from "@budget/domain";
import {
  audit,
  bumpDataVersion,
  closedPeriods,
  ensurePartitions,
  insertProjectionFacts,
  matchRunFacts,
  outbox,
  runCoverage,
  upsertKpiFacts,
  upsertSpendFacts,
  withTenant,
  type FactLoad,
  type KpiFactInput,
  type ProjectionFactInput,
  type RunCoverage,
  type SpendFactInput,
  type TenantContext,
  type Tx,
} from "@budget/db";
import { Decimal } from "decimal.js";
import type { Prisma, PrismaClient } from "@prisma/client";
import { log } from "../log.js";
import { connectorFor } from "./connectors/index.js";
import { RegistryIndex, normalize, type RegistryValue } from "./normalize.js";
import type { ObjectStore } from "./object-store.js";
import type { Connector, DataSourceRef, RawRow } from "./types.js";

/**
 * runIngest (spec §14 pipeline): stream the source → normalize and validate against the registry →
 * upsert facts in batches → write rejected rows to the object store → match the run's facts to
 * envelopes → finish the run with one audit_event and one `facts.loaded` outbox row.
 */

export interface IngestDeps {
  prisma: PrismaClient; // budget_app
  store: ObjectStore;
  /** Bucket for rejected-rows reports: gs://<bucket>/reports/<workspaceId>/<runId>.csv */
  reportBucket: string;
  connector?: (kind: string) => Connector;
  /** Secret Manager lookup for `config.secretRef` (phase 20); sources without a secret need none. */
  secrets?: (ref: string) => Promise<Record<string, string>>;
  batchSize?: number;
}

export interface IngestResult {
  runId: string;
  status: "ok";
  rowsRead: number;
  rowsAccepted: number;
  rowsRejected: number;
  errorReportUri: string | null;
  coverage: RunCoverage & { matchCoverage: string };
  envelopeIds: string[];
}

const BATCH = 5_000;
const TX = { timeoutMs: 120_000 };

function systemCtx(workspaceId: string, orgId: string, runId: string): TenantContext {
  return { workspaceId, orgId, userId: null, isOrgAdmin: false, actorType: "system", requestId: `ingest-${runId}` };
}

async function loadRegistry(tx: Tx, orgId: string, workspaceId: string): Promise<RegistryIndex> {
  const dims = await tx.dimension.findMany({ where: { orgId, isActive: true, OR: [{ workspaceId: null }, { workspaceId }] }, select: { id: true, key: true, workspaceId: true } });
  // A workspace dimension shadows an org-wide one with the same key.
  const byKey = new Map<string, { id: string; workspaceId: string | null }>();
  for (const d of dims) if (!byKey.has(d.key) || d.workspaceId !== null) byKey.set(d.key, d);
  const values = await tx.dimensionValue.findMany({
    where: { dimensionId: { in: [...byKey.values()].map((d) => d.id) } },
    select: { id: true, dimensionId: true, code: true, aliases: true, externalIds: true, isActive: true, mergedIntoId: true },
  });
  const codeById = new Map(values.map((v) => [v.id, v.code]));
  const out = new Map<string, RegistryValue[]>();
  for (const [key, d] of byKey) {
    out.set(
      key,
      values
        .filter((v) => v.dimensionId === d.id)
        .map((v) => ({
          code: v.code,
          aliases: v.aliases,
          externalIds: Object.values((v.externalIds ?? {}) as Record<string, unknown>).map(String),
          mergedInto: v.mergedIntoId ? (codeById.get(v.mergedIntoId) ?? null) : null,
          isActive: v.isActive,
        })),
    );
  }
  return new RegistryIndex(out);
}

/** FX into the reporting currency: the latest rate on or before the fact's date (cached per currency and date). */
class FxCache {
  private readonly cache = new Map<string, { id: string | null; rate: Decimal } | null>();
  constructor(private readonly reporting: string) {}
  async rate(tx: Tx, currency: string, date: string): Promise<{ id: string | null; rate: Decimal } | null> {
    if (currency === this.reporting) return { id: null, rate: new Decimal(1) };
    const key = `${currency}|${date}`;
    if (!this.cache.has(key)) {
      const fx = await tx.fxRate.findFirst({ where: { base: currency, quote: this.reporting, asOfDate: { lte: new Date(`${date}T00:00:00Z`) } }, orderBy: { asOfDate: "desc" } });
      this.cache.set(key, fx ? { id: fx.id, rate: new Decimal(fx.rate.toString()) } : null);
    }
    return this.cache.get(key) ?? null;
  }
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Rejected rows as CSV: the source columns, then `_line` and `_reason`. */
export function rejectReport(rejected: Array<{ line: number; row: RawRow; reason: string }>): string {
  const columns = [...new Set(rejected.flatMap((r) => Object.keys(r.row)))];
  const lines = [[...columns, "_line", "_reason"].map(csvCell).join(",")];
  for (const r of rejected) lines.push([...columns.map((c) => r.row[c]), r.line, r.reason].map(csvCell).join(","));
  return `${lines.join("\n")}\n`;
}

export async function runIngest(deps: IngestDeps, tenant: { workspaceId: string; orgId: string }, runId: string): Promise<IngestResult> {
  const ctx = systemCtx(tenant.workspaceId, tenant.orgId, runId);
  const prisma = deps.prisma;
  const batchSize = deps.batchSize ?? BATCH;
  const setup = await withTenant(prisma, ctx, async (tx) => {
    const run = await tx.ingestRun.findUnique({ where: { id: runId } });
    if (run === null) throw new Error(`ingest run ${runId} not found`);
    if (run.status !== "queued" && run.status !== "running") throw new Error(`ingest run ${runId} is ${run.status}`);
    const source = await tx.dataSource.findUnique({ where: { id: run.sourceId } });
    if (source === null || source.workspaceId !== tenant.workspaceId) throw new Error(`source ${run.sourceId} not found in workspace`);
    await tx.ingestRun.update({ where: { id: runId }, data: { status: "running", startedAt: new Date() } });
    const ws = await tx.workspace.findUniqueOrThrow({ where: { id: tenant.workspaceId }, select: { reportingCurrency: true } });
    const previous = await tx.ingestRun.findFirst({ where: { sourceId: source.id, status: "ok" }, orderBy: { startedAt: "desc" }, select: { startedAt: true } });
    // Facts dated in a closed period are rejected unless the run is flagged as its restatement (spec §15).
    const restatementOf = ((run.summary ?? {}) as { restatementOf?: string }).restatementOf ?? null;
    const closed = (await closedPeriods(tx, tenant.workspaceId)).filter((c) => c.closureId !== restatementOf);
    return { source, registry: await loadRegistry(tx, tenant.orgId, tenant.workspaceId), reporting: ws.reportingCurrency, since: previous?.startedAt, closed, restatementOf };
  });

  try {
    const config = SourceConfig.parse(setup.source.config);
    const mapping = SourceMapping.parse(setup.source.mapping);
    const unknown = Object.values(mapping.columns).flatMap((c) => ("dimension" in c && !setup.registry.has(c.dimension) ? [c.dimension] : []));
    if (unknown.length) throw new Error(`mapping names unknown dimensions: ${[...new Set(unknown)].join(", ")}`);
    const ref: DataSourceRef = { id: setup.source.id, workspaceId: setup.source.workspaceId, kind: setup.source.kind, config };
    const secretRef = "secretRef" in config ? config.secretRef : undefined;
    const secret = secretRef ? await (deps.secrets ?? noSecrets)(secretRef) : {};
    const connector = (deps.connector ?? ((kind: string) => connectorFor(kind, deps.store)))(setup.source.kind);
    const load: FactLoad = { workspaceId: tenant.workspaceId, sourceSystem: setup.source.kind, sourceRunId: runId };
    const fx = new FxCache(setup.reporting);

    let rowsRead = 0;
    let rowsAccepted = 0;
    const rejected: Array<{ line: number; row: RawRow; reason: string }> = [];
    let batch: Array<{ line: number; row: RawRow }> = [];

    const flush = async () => {
      if (batch.length === 0) return;
      const rows = batch;
      batch = [];
      await withTenant(
        prisma,
        ctx,
        async (tx) => {
          const spend: SpendFactInput[] = [];
          const kpi: KpiFactInput[] = [];
          const projection: ProjectionFactInput[] = [];
          for (const { line, row } of rows) {
            const res = normalize(row, mapping, setup.registry, setup.source.id);
            if ("rejected" in res) {
              rejected.push({ line, row, reason: res.rejected });
              continue;
            }
            const pending: { spend: SpendFactInput[]; kpi: KpiFactInput[]; projection: ProjectionFactInput[] } = { spend: [], kpi: [], projection: [] };
            let reason: string | null = null;
            for (const f of res.facts) {
              const closedIn = setup.closed.find((c) => f.periodDate >= c.start && f.periodDate <= c.end);
              if (closedIn) {
                reason = `period ${closedIn.key} is closed (restate it, or run with restatementOf=${closedIn.closureId})`;
                break;
              }
              if (f.kind === "spend" && f.amount !== undefined && f.currency !== undefined) {
                const rate = await fx.rate(tx, f.currency, f.periodDate);
                if (rate === null) {
                  reason = `no FX rate ${f.currency}→${setup.reporting} on ${f.periodDate}`;
                  break;
                }
                pending.spend.push({ dimensionValues: f.dimensionValues, periodDate: f.periodDate, currency: f.currency, amount: f.amount, amountReporting: new Decimal(f.amount).mul(rate.rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2), fxRateId: rate.id, rowHash: f.rowHash });
              } else if (f.kind === "kpi" && f.metric !== undefined && f.value !== undefined) {
                pending.kpi.push({ dimensionValues: f.dimensionValues, periodDate: f.periodDate, metric: f.metric, value: f.value, attributionModel: f.attributionModel ?? null, rowHash: f.rowHash });
              } else if (f.kind === "projection" && f.metric !== undefined && f.value !== undefined && f.formulaVersion !== undefined && f.horizonEnd !== undefined) {
                pending.projection.push({ dimensionValues: f.dimensionValues, periodDate: f.periodDate, metric: f.metric, value: f.value, valueReporting: f.metric === "spend" ? f.value : null, formulaVersion: f.formulaVersion, horizonEnd: f.horizonEnd });
              }
            }
            if (reason !== null) {
              rejected.push({ line, row, reason });
              continue;
            }
            spend.push(...pending.spend);
            kpi.push(...pending.kpi);
            projection.push(...pending.projection);
            rowsAccepted += 1;
          }
          const dates = [...spend, ...kpi, ...projection].map((f) => f.periodDate).sort();
          if (dates.length) await ensurePartitions(tx, dates[0] as string, dates[dates.length - 1] as string);
          await upsertSpendFacts(tx, load, spend);
          await upsertKpiFacts(tx, load, kpi);
          await insertProjectionFacts(tx, load, projection);
        },
        TX,
      );
    };

    for await (const row of connector.read(ref, secret, setup.since)) {
      rowsRead += 1;
      batch.push({ line: rowsRead + 1, row }); // line 1 is the header
      if (batch.length >= batchSize) await flush();
    }
    await flush();

    let errorReportUri: string | null = null;
    if (rejected.length) {
      errorReportUri = `gs://${deps.reportBucket}/reports/${tenant.workspaceId}/${runId}.csv`;
      await deps.store.write(errorReportUri, rejectReport(rejected), "text/csv");
    }
    const reasons: Record<string, number> = {};
    for (const r of rejected) {
      const key = r.reason.replace(/"[^"]*"/g, '"…"');
      reasons[key] = (reasons[key] ?? 0) + 1;
    }

    return await withTenant(
      prisma,
      ctx,
      async (tx) => {
        const envelopeIds = await matchRunFacts(tx, tenant.workspaceId, runId);
        const coverage = await runCoverage(tx, tenant.workspaceId, runId);
        const matchCoverage = new Decimal(coverage.spend).isZero() ? "1" : new Decimal(coverage.matchedSpend).div(coverage.spend).toDecimalPlaces(6).toString();
        const summary = { ...coverage, matchCoverage, envelopes: envelopeIds.length, rejectReasons: reasons, ...(setup.restatementOf ? { restatementOf: setup.restatementOf } : {}) };
        await tx.ingestRun.update({
          where: { id: runId },
          data: { status: "ok", finishedAt: new Date(), rowsRead, rowsAccepted, rowsRejected: rejected.length, errorReportUri, summary: summary as unknown as Prisma.InputJsonObject },
        });
        await audit(tx, { workspaceId: tenant.workspaceId, actorId: null, actorType: "system", action: "ingest.run.finished", entityType: "ingest_run", entityId: runId, after: { sourceId: setup.source.id, rowsRead, rowsAccepted, rowsRejected: rejected.length, errorReportUri, matchCoverage }, requestId: ctx.requestId });
        await outbox(tx, { workspaceId: tenant.workspaceId, topic: "facts.loaded", payload: { runId, sourceId: setup.source.id, envelopeIds } });
        await bumpDataVersion(tx, tenant.workspaceId);
        log.info({ runId, sourceId: setup.source.id, workspaceId: tenant.workspaceId, requestId: ctx.requestId, rowsRead, rowsRejected: rejected.length, matchCoverage }, "ingest run finished");
        return { runId, status: "ok" as const, rowsRead, rowsAccepted, rowsRejected: rejected.length, errorReportUri, coverage: { ...coverage, matchCoverage }, envelopeIds };
      },
      TX,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await withTenant(prisma, ctx, async (tx) => {
      await tx.ingestRun.update({ where: { id: runId }, data: { status: "failed", finishedAt: new Date(), summary: { error: message.slice(0, 2000) } } });
      await audit(tx, { workspaceId: tenant.workspaceId, actorId: null, actorType: "system", action: "ingest.run.failed", entityType: "ingest_run", entityId: runId, after: { sourceId: setup.source.id, error: message.slice(0, 2000) }, requestId: ctx.requestId });
      await outbox(tx, { workspaceId: tenant.workspaceId, topic: "ingest.failed", payload: { runId, sourceId: setup.source.id } });
    });
    log.error({ err: error, runId, workspaceId: tenant.workspaceId, requestId: ctx.requestId }, "ingest run failed");
    throw error;
  }
}

async function noSecrets(ref: string): Promise<Record<string, string>> {
  throw new Error(`source needs secret ${ref}, and no Secret Manager client is configured (phase 20)`);
}
