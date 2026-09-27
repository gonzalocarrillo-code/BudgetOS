import { DomainError, TreeRequest, readScopeFilter, resolvePeriod, type QueryRow, type TreeResponse } from "@budget/domain";
import { withTenant } from "@budget/db";
import { NONE_SEGMENT, ROOT_PATH, compileTree } from "@budget/query-planner";
import type { PrismaClient } from "@prisma/client";
import { parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";

/**
 * POST /workspaces/:ws/tree (ADR-038): one level of a hierarchy template's tree read from
 * rollup_cache, so the Explorer's tree is not computed on read (plan §5.3). The cache holds
 * workspace-wide totals: a caller with a scoped read role gets `available: false` and asks /query,
 * which cuts every row to their scope. So does a period the cache does not hold.
 */

type Cached = { node_path: string; measures: Record<string, string | number | null>; data_version: bigint | number };

const unavailable = (reason: "scoped" | "not_cached", dataVersion: number, now: Date, started: number): TreeResponse => ({
  available: false,
  reason,
  rows: [],
  totals: {},
  dataAsOf: now.toISOString(),
  dataVersion,
  cacheVersion: null,
  elapsedMs: Math.round(performance.now() - started),
});

const text = (v: unknown) => (v === null || v === undefined ? null : String(v));

export async function treeQuery(prisma: PrismaClient, auth: AuthContext, raw: unknown, now: Date = new Date()): Promise<TreeResponse> {
  const started = performance.now();
  const q = parseInput(TreeRequest, raw);
  if (q.workspaceId !== requireWorkspace(auth.ctx.workspaceId)) throw new DomainError("VALIDATION", "tree.workspaceId must be the caller's workspace");
  return withTenant(prisma, auth.ctx, async (tx) => {
    const ws = await tx.workspace.findUniqueOrThrow({ where: { id: q.workspaceId }, select: { fiscalYearStartMonth: true, settings: true } });
    const dataVersion = Number((ws.settings as { dataVersion?: number } | null)?.dataVersion ?? 0);
    if (!auth.isOrgAdmin && readScopeFilter(auth.assignments, "envelope.read") !== null) return unavailable("scoped", dataVersion, now, started);
    const template = await tx.hierarchyTemplate.findFirst({ where: { id: q.templateId, workspaceId: q.workspaceId }, select: { path: true } });
    if (!template) throw new DomainError("NOT_FOUND", "hierarchy template not found", { templateId: q.templateId });
    const parentDepth = q.parentPath === ROOT_PATH ? 0 : q.parentPath.split("/").length;
    if (parentDepth >= template.path.length) throw new DomainError("VALIDATION", "parentPath is at or below the template's last level; its envelopes come from /query", { parentPath: q.parentPath });
    const period = resolvePeriod(q.period, now.toISOString().slice(0, 10), ws.fiscalYearStartMonth);
    const read = async (parentPath: string | undefined, maxDepth: number | undefined) => {
      const c = compileTree({ workspaceId: q.workspaceId, templateId: q.templateId, period, ...(parentPath === undefined ? {} : { parentPath }), ...(maxDepth === undefined ? {} : { maxDepth }) });
      return tx.$queryRawUnsafe<Cached[]>(c.sql, ...c.values);
    };
    const [root] = await read(undefined, 0);
    if (!root) return unavailable("not_cached", dataVersion, now, started);
    const children = await read(q.parentPath, undefined);
    const measures = [...new Set(q.measures)];
    const pick = (m: Cached["measures"]) => Object.fromEntries(measures.map((k) => [k, text(m[k])]));
    const keys = template.path.slice(0, parentDepth + 1);
    const rows: QueryRow[] = children.map((n) => {
      const segments = n.node_path.split("/");
      return {
        key: n.node_path,
        envelopeId: null,
        path: segments,
        dimensions: Object.fromEntries(keys.map((k, i) => [k, segments[i] === NONE_SEGMENT ? null : (segments[i] ?? null)])),
        measures: pick(n.measures),
        targets: {},
        status: null,
        pendingCount: Number(n.measures["pendingCount"] ?? 0),
        openAlerts: 0,
        openThreads: 0,
      };
    });
    const versions = [root, ...children].map((n) => Number(n.data_version));
    return {
      available: true,
      reason: null,
      rows,
      totals: { ...pick(root.measures), leafCount: text(root.measures["leafCount"]) },
      dataAsOf: now.toISOString(),
      dataVersion,
      cacheVersion: Math.min(...versions),
      elapsedMs: Math.round(performance.now() - started),
    };
  });
}
