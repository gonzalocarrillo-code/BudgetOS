import { DomainError, SourceConfig, SourceMapping, compileParsePattern, csvCell, isIncrementalSource, rowIdentityProblem } from "@budget/domain";
import {
  audit,
  bumpDataVersion,
  closedPeriods,
  ensurePartitions,
  insertProjectionFacts,
  matchRunFacts,
  outbox,
  runCoverage,
  runEnvelopes,
  supersedeMovedFacts,
  supersedeUnseenFacts,
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
import { RegistryIndex, normalize, occurrenceKey, type MatchKeys, type RegistryValue } from "./normalize.js";
import type { ObjectStore } from "./object-store.js";
import type { Connector, DataSourceRef, RawRow } from "./types.js";

/**
 * runIngest (spec §14 pipeline): stream the source → normalize and validate against the registry →
 * upsert facts in batches → write rejected rows to the object store → match the run's facts to
 * envelopes → finish the run with one audit_event and one `facts.loaded` outbox row.
 *
 * ADR-071: a fact is keyed by its natural key (the source's row_id, or its business key), never by
 * its measure, so a restated row updates its fact. A run is either
 * - **full** (CSV, Sheets, a warehouse table without an updated-at column, the first run of an
 *   incremental source, or a requested full resync): authoritative for its source over the dates it
 *   covers. At the end, the source's live facts in that range the run did not load are superseded
 *   (closed periods it may not restate are left alone); or
 * - **incremental** (Snowflake, BigQuery with `updatedAtColumn`): only rows changed since the last
 *   run, minus an overlap window; each upserts by row id, and a row that moved to another date
 *   supersedes its old date. It cannot see deletes; a full resync can.
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
/**
 * I-30: an incremental run re-reads rows updated up to this long before the previous run started,
 * for warehouse rows committed late with an earlier updated-at. Row-id upserts make the re-read harmless.
 */
export const SINCE_OVERLAP_MS = 60 * 60 * 1000;
const TX = { timeoutMs: 120_000 };

function systemCtx(workspaceId: string, orgId: string, runId: string): TenantContext {
  return { workspaceId, orgId, userId: null, isOrgAdmin: false, actorType: "system", requestId: `ingest-${runId}` };
}

export async function loadRegistry(tx: Tx, orgId: string, workspaceId: string): Promise<RegistryIndex> {
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
export class FxCache {
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
    const previous = await tx.ingestRun.findFirst({ where: { sourceId: source.id, status: "ok" }, orderBy: { startedAt: "desc" }, select: { startedAt: true, summary: true } });
    // Facts dated in a closed period are rejected unless the run is flagged as its restatement (spec §15).
    const requested = (run.summary ?? {}) as { restatementOf?: string; mode?: string };
    const restatementOf = requested.restatementOf ?? null;
    const closed = (await closedPeriods(tx, tenant.workspaceId)).filter((c) => c.closureId !== restatementOf);
    // §24.3 step 2: every live envelope's match key → its tuple (only when the mapping has a match_key column).
    const parsed = SourceMapping.safeParse(source.mapping);
    const hasKey = parsed.success && Object.values(parsed.data.columns).some((c) => "role" in c && c.role === "match_key");
    const keyed = hasKey ? await tx.envelope.findMany({ where: { workspaceId: tenant.workspaceId, status: { not: "ARCHIVED" }, matchKey: { not: null } }, select: { matchKey: true, dimensionValues: true } }) : [];
    const keys: MatchKeys = { envelopes: new Map(keyed.map((e) => [String(e.matchKey).toLowerCase(), e.dimensionValues as Record<string, string>])), pattern: source.parsePattern ? compileParsePattern(source.parsePattern) : null };
    // ADR-071: incremental only after a run that already keyed its facts (a run before ADR-071 has no `mode`).
    const previousKeyed = previous !== null && typeof (previous.summary as { mode?: unknown } | null)?.mode === "string";
    const since = requested.mode !== "full" && previousKeyed ? new Date(previous.startedAt.getTime() - SINCE_OVERLAP_MS) : undefined;
    return { source, registry: await loadRegistry(tx, tenant.orgId, tenant.workspaceId), reporting: ws.reportingCurrency, since, closed, restatementOf, keys };
  });

  try {
    const config = SourceConfig.parse(setup.source.config);
    const mapping = SourceMapping.parse(setup.source.mapping);
    const identityProblem = rowIdentityProblem(config, mapping);
    if (identityProblem) throw new DomainError("VALIDATION", identityProblem, { sourceId: setup.source.id });
    const mode: "full" | "incremental" = isIncrementalSource(config) && setup.since !== undefined ? "incremental" : "full";
    const since = mode === "incremental" ? setup.since : undefined;
    const byRowId = Object.values(mapping.columns).some((c) => "role" in c && c.role === "row_id");
    // W4-1: a money projection ("spend") takes its currency from a column, or a constant on the
    // projection role, else falls back to the workspace's reporting currency (never rejected for
    // it, unlike spend). Recorded once per run in summary.projectionCurrency (audit T-4).
    const roleColumns = Object.values(mapping.columns).flatMap((c) => ("role" in c ? [c] : []));
    const projectionRole = roleColumns.find((r) => r.role === "projection");
    const hasCurrencyColumn = roleColumns.some((r) => r.role === "currency");
    let projectionCurrencySource: "column" | "constant" | "workspace_fallback" | null = null;
    if (projectionRole && projectionRole.role === "projection" && projectionRole.metric === "spend") {
      projectionCurrencySource = hasCurrencyColumn ? "column" : projectionRole.currency !== undefined ? "constant" : "workspace_fallback";
    }
    const unknown = Object.values(mapping.columns).flatMap((c) => ("dimension" in c && !setup.registry.has(c.dimension) ? [c.dimension] : []));
    if (unknown.length) throw new Error(`mapping names unknown dimensions: ${[...new Set(unknown)].join(", ")}`);
    const groups = setup.keys.pattern ? [...(setup.source.parsePattern ?? "").matchAll(/\(\?<([a-z][a-z0-9_]*)>/g)].map((m) => m[1] as string) : [];
    const unknownGroups = groups.filter((g) => !setup.registry.has(g));
    if (unknownGroups.length) throw new Error(`parse pattern names unknown dimensions: ${unknownGroups.join(", ")}`);
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
    // ADR-071: how often each business key has occurred in this extract (the occurrence is part of the key).
    const occurrences = new Map<string, number>();
    let covered: { from: string; to: string } | null = null;
    const moved = { count: 0, envelopeIds: new Set<string>() };

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
            const res = normalize(row, mapping, setup.registry, setup.source.id, setup.keys);
            if ("rejected" in res) {
              rejected.push({ line, row, reason: res.rejected });
              continue;
            }
            const date = res.facts[0]?.periodDate;
            if (date !== undefined) covered = covered === null ? { from: date, to: date } : { from: date < covered.from ? date : covered.from, to: date > covered.to ? date : covered.to };
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
                pending.spend.push({ dimensionValues: f.dimensionValues, periodDate: f.periodDate, currency: f.currency, amount: f.amount, amountReporting: new Decimal(f.amount).mul(rate.rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2), fxRateId: rate.id, rowHash: f.rowHash, matchMethod: f.matchHint ?? null });
              } else if (f.kind === "kpi" && f.metric !== undefined && f.value !== undefined) {
                pending.kpi.push({ dimensionValues: f.dimensionValues, periodDate: f.periodDate, metric: f.metric, value: f.value, attributionModel: f.attributionModel ?? null, rowHash: f.rowHash, matchMethod: f.matchHint ?? null });
              } else if (f.kind === "projection" && f.metric !== undefined && f.value !== undefined && f.formulaVersion !== undefined && f.horizonEnd !== undefined) {
                if (f.metric === "spend") {
                  // W4-1: no column/constant resolved a currency for this row → the workspace's reporting currency.
                  const currency = f.currency ?? setup.reporting;
                  const rate = await fx.rate(tx, currency, f.periodDate);
                  if (rate === null) {
                    reason = `no FX rate ${currency}→${setup.reporting} on ${f.periodDate}`;
                    break;
                  }
                  pending.projection.push({ dimensionValues: f.dimensionValues, periodDate: f.periodDate, metric: f.metric, value: f.value, currency, valueReporting: new Decimal(f.value).mul(rate.rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2), fxRateId: rate.id, formulaVersion: f.formulaVersion, horizonEnd: f.horizonEnd, matchMethod: f.matchHint ?? null });
                } else {
                  pending.projection.push({ dimensionValues: f.dimensionValues, periodDate: f.periodDate, metric: f.metric, value: f.value, currency: null, valueReporting: null, fxRateId: null, formulaVersion: f.formulaVersion, horizonEnd: f.horizonEnd, matchMethod: f.matchHint ?? null });
                }
              }
            }
            if (reason !== null) {
              rejected.push({ line, row, reason });
              continue;
            }
            if (!byRowId) {
              for (const f of [...pending.spend, ...pending.kpi]) {
                const n = occurrences.get(f.rowHash) ?? 0;
                occurrences.set(f.rowHash, n + 1);
                f.rowHash = occurrenceKey(f.rowHash, n);
              }
            }
            spend.push(...pending.spend);
            kpi.push(...pending.kpi);
            projection.push(...pending.projection);
            rowsAccepted += 1;
          }
          const dates = [...spend, ...kpi, ...projection].map((f) => f.periodDate).sort();
          if (dates.length) await ensurePartitions(tx, dates[0] as string, dates[dates.length - 1] as string);
          // One statement may not upsert a key twice: a row id delivered twice in a batch keeps its last delivery.
          const last = <T extends { rowHash: string; periodDate: string }>(rows: T[]) => [...new Map(rows.map((r) => [`${r.rowHash}|${r.periodDate}`, r])).values()];
          const spendRows = last(spend);
          const kpiRows = last(kpi);
          await upsertSpendFacts(tx, load, spendRows);
          await upsertKpiFacts(tx, load, kpiRows);
          await insertProjectionFacts(tx, load, projection);
          if (byRowId) {
            for (const [table, rows] of [["spend_fact", spendRows], ["kpi_fact", kpiRows]] as const) {
              const m = await supersedeMovedFacts(tx, tenant.workspaceId, runId, table, rows.map((r) => r.rowHash));
              moved.count += m.count;
              for (const e of m.envelopeIds) moved.envelopeIds.add(e);
            }
          }
        },
        TX,
      );
    };

    for await (const row of connector.read(ref, secret, since)) {
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
        // ADR-071: a full extract supersedes the source's facts it no longer has, over the dates it covers.
        const unseen =
          mode === "full" && covered !== null
            ? await supersedeUnseenFacts(tx, { workspaceId: tenant.workspaceId, sourceId: setup.source.id, runId, from: covered.from, to: covered.to, keep: setup.closed.map((c) => ({ start: c.start, end: c.end })) })
            : { spend: 0, kpi: 0, projection: 0, envelopeIds: [] };
        const matched = await matchRunFacts(tx, tenant.workspaceId, runId);
        // Every envelope whose facts this run loaded, changed or superseded: their roll-ups are stale.
        const envelopeIds = [...new Set([...matched, ...(await runEnvelopes(tx, tenant.workspaceId, runId)), ...unseen.envelopeIds, ...moved.envelopeIds])].sort();
        const superseded = unseen.spend + unseen.kpi + unseen.projection + moved.count;
        const coverage = await runCoverage(tx, tenant.workspaceId, runId);
        const matchCoverage = new Decimal(coverage.spend).isZero() ? "1" : new Decimal(coverage.matchedSpend).div(coverage.spend).toDecimalPlaces(6).toString();
        const summary = { ...coverage, matchCoverage, envelopes: envelopeIds.length, rejectReasons: reasons, mode, superseded, coveredRange: covered, ...(setup.restatementOf ? { restatementOf: setup.restatementOf } : {}), ...(projectionCurrencySource ? { projectionCurrency: projectionCurrencySource } : {}) };
        await tx.ingestRun.update({
          where: { id: runId },
          data: { status: "ok", finishedAt: new Date(), rowsRead, rowsAccepted, rowsRejected: rejected.length, errorReportUri, summary: summary as unknown as Prisma.InputJsonObject },
        });
        await audit(tx, { workspaceId: tenant.workspaceId, actorId: null, actorType: "system", action: "ingest.run.finished", entityType: "ingest_run", entityId: runId, after: { sourceId: setup.source.id, rowsRead, rowsAccepted, rowsRejected: rejected.length, errorReportUri, matchCoverage, mode, superseded, coveredRange: covered }, requestId: ctx.requestId });
        await outbox(tx, { workspaceId: tenant.workspaceId, topic: "facts.loaded", payload: { runId, sourceId: setup.source.id, envelopeIds } });
        await bumpDataVersion(tx, tenant.workspaceId);
        log.info({ runId, sourceId: setup.source.id, workspaceId: tenant.workspaceId, requestId: ctx.requestId, rowsRead, rowsRejected: rejected.length, matchCoverage, mode, superseded }, "ingest run finished");
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
