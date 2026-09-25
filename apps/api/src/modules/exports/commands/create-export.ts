import { CreateExportInput, DomainError, QueryRequest, newId, readScopeFilter, resolvePeriod, type FilterGroupT } from "@budget/domain";
import { audit, outbox, plannerOptions, withTenant } from "@budget/db";
import { compileQuery, compileTotals } from "@budget/query-planner";
import type { Prisma, PrismaClient } from "@prisma/client";
import { parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { exportView } from "../queries/get-export.js";

/**
 * POST /exports (plan §6.2, ADR-017): queues a job for the export-worker; the file is never built
 * in the request. The caller's read scope is ANDed into the filter here, so the worker (a system
 * actor) exports exactly what the caller's grid shows. The query is compiled once to reject what
 * the planner would refuse with a 422 now rather than a failed job later.
 */
export async function createExport(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = parseInput(CreateExportInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  if (input.query.workspaceId !== workspaceId) throw new DomainError("VALIDATION", "query.workspaceId must be the X-Workspace-Id workspace");
  if (input.kind === "sheets") throw new DomainError("UNAVAILABLE", "Sheets push is not configured in this environment");
  const scope = auth.isOrgAdmin ? null : readScopeFilter(auth.assignments, "envelope.read");
  const own = input.query.filter;
  const filter: FilterGroupT | undefined = scope === null ? own : own ? { logic: "and", children: [own, scope] } : scope;
  // The worker pages the whole result itself: the grid's cursor is dropped, its limit is not used.
  const query: QueryRequest = QueryRequest.parse({ ...input.query, ...(filter ? { filter } : {}) });
  delete query.cursor;
  const day = new Date().toISOString().slice(0, 10);
  const filename = input.filename ?? `budget-os-export-${day}`;
  return withTenant(prisma, auth.ctx, async (tx) => {
    const ws = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { fiscalYearStartMonth: true } });
    const period = resolvePeriod(query.period, day, ws.fiscalYearStartMonth);
    const opts = await plannerOptions(tx, { orgId: auth.user.orgId, workspaceId }, query.targets, period);
    compileQuery(query, period, day, opts);
    compileTotals(query, period, day, opts);
    const job = await tx.exportJob.create({ data: { id: newId(), workspaceId, kind: input.kind, query: query as Prisma.InputJsonValue, filename, createdBy: auth.user.id } });
    await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "export.requested", entityType: "export_job", entityId: job.id, after: { kind: job.kind, filename, scoped: scope !== null }, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId, topic: "export.requested", payload: { jobId: job.id } });
    return exportView(job, null);
  });
}
