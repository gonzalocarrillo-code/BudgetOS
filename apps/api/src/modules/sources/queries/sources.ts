import { DomainError, SourceConfig, SourceMapping } from "@budget/domain";
import { unmatchedSpend, withTenant } from "@budget/db";
import { MAX_SAMPLE_ROWS, mapColumns, openAiClient } from "@budget/ai";
import { connectorFor, type ObjectStore } from "@budget/workers";
import type { PrismaClient } from "@prisma/client";
import { parseId, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { sourceView } from "../commands/sources.js";

/** GET /workspaces/:ws/sources. */
export function listSources(prisma: PrismaClient, auth: AuthContext) {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => (await tx.dataSource.findMany({ where: { workspaceId }, orderBy: { name: "asc" } })).map(sourceView));
}

/** GET /sources/:id/runs: newest first, with coverage and the rejected-rows report. */
export function listRuns(prisma: PrismaClient, auth: AuthContext, rawId: string) {
  const sourceId = parseId(rawId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const source = await tx.dataSource.findUnique({ where: { id: sourceId }, select: { id: true } });
    if (source === null) throw new DomainError("NOT_FOUND", "Source not found");
    const runs = await tx.ingestRun.findMany({ where: { sourceId }, orderBy: { startedAt: "desc" }, take: 100 });
    return runs.map((r) => ({
      id: r.id,
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      rowsRead: r.rowsRead,
      rowsAccepted: r.rowsAccepted,
      rowsRejected: r.rowsRejected,
      errorReportUri: r.errorReportUri,
      summary: r.summary,
    }));
  });
}

/** GET /workspaces/:ws/unmatched-spend?limit: unmatched spend by tuple, largest first. */
export function listUnmatched(prisma: PrismaClient, auth: AuthContext, rawLimit: string | undefined) {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const limit = rawLimit === undefined ? 100 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new DomainError("VALIDATION", "limit must be 1..1000");
  return withTenant(prisma, auth.ctx, (tx) => unmatchedSpend(tx, workspaceId, limit));
}

/**
 * POST /sources/:id/suggest-mapping (spec §14): the header and the first 20 rows go to
 * @budget/ai mapColumns(). Nothing is saved; the user confirms. 503 without OPENAI_API_KEY.
 */
export async function suggestMapping(prisma: PrismaClient, store: ObjectStore, auth: AuthContext, rawId: string) {
  const sourceId = parseId(rawId);
  const { source, dimensionKeys } = await withTenant(prisma, auth.ctx, async (tx) => {
    const s = await tx.dataSource.findUnique({ where: { id: sourceId } });
    if (s === null) throw new DomainError("NOT_FOUND", "Source not found");
    const dims = await tx.dimension.findMany({ where: { orgId: auth.user.orgId, isActive: true, OR: [{ workspaceId: null }, { workspaceId: s.workspaceId }] }, select: { key: true } });
    return { source: s, dimensionKeys: [...new Set(dims.map((d) => d.key))].sort() };
  });
  const client = openAiClient(); // 503 before any source data is read
  const config = SourceConfig.parse(source.config);
  if ("secretRef" in config && config.secretRef) throw new DomainError("UNAVAILABLE", "Reading this source needs Secret Manager (phase 20)");
  const header = new Set<string>();
  const rows: Array<Record<string, string | number | null>> = [];
  for await (const row of connectorFor(source.kind, store).read({ id: source.id, workspaceId: source.workspaceId, kind: source.kind, config }, {})) {
    Object.keys(row).forEach((k) => header.add(k));
    rows.push(row);
    if (rows.length >= MAX_SAMPLE_ROWS) break;
  }
  const cols = [...header];
  const suggestion = await mapColumns({ header: cols, rows: rows.map((r) => cols.map((c) => r[c] ?? null)) }, dimensionKeys, client);
  return { sourceId, mapping: SourceMapping.parse(suggestion.mapping), model: suggestion.model, applied: false };
}
