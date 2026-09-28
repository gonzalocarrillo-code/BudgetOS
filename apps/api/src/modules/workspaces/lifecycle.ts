import { DeleteWorkspaceInput, DomainError, UpdateWorkspaceStatusInput, type OrgWorkspacesResponse } from "@budget/domain";
import { audit, outbox, withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseInput, requireWorkspace } from "../../common/parse-input.js";
import type { AuthContext } from "../../common/tenant.js";

/**
 * Workspace lifecycle for superadmins (ADR-052): the org console's list, archive and restore,
 * delete (a tombstone, purged by the workers after the retention window) and undelete. Every step
 * writes one audit_event and one outbox row in its transaction.
 */

const retentionDays = () => Math.max(0, Number(process.env["WORKSPACE_RETENTION_DAYS"] ?? 30));

function superadminOnly(auth: AuthContext): void {
  if (!auth.isOrgAdmin) throw new DomainError("FORBIDDEN", "Only a superadmin manages workspaces");
}

/** The org-level session: the org-admin bypass reads and writes every workspace of the caller's org. */
const orgCtx = (auth: AuthContext, workspaceId: string | null = null) => ({ ...auth.ctx, workspaceId, isOrgAdmin: true, actingAs: "superadmin" as const });

/** GET /workspaces — every workspace of the org that is not deleted, with its admins and a few counts. */
export async function listWorkspaces(prisma: PrismaClient, auth: AuthContext): Promise<OrgWorkspacesResponse> {
  superadminOnly(auth);
  return withTenant(prisma, orgCtx(auth), async (tx) => {
    const rows = await tx.workspace.findMany({ where: { orgId: auth.user.orgId, deletedAt: null }, orderBy: [{ status: "asc" }, { name: "asc" }] });
    const ids = rows.map((w) => w.id);
    const [roles, budgets, activity] = await Promise.all([
      tx.roleAssignment.findMany({ where: { workspaceId: { in: ids } }, select: { workspaceId: true, principalType: true, principalId: true, role: true } }),
      tx.envelope.groupBy({ by: ["workspaceId"], where: { workspaceId: { in: ids }, status: { not: "ARCHIVED" } }, _count: { _all: true } }),
      ids.length ? tx.$queryRaw<Array<{ workspace_id: string; at: Date }>>`SELECT workspace_id::text, max(occurred_at) AS at FROM audit_event WHERE workspace_id = ANY(${ids}::uuid[]) GROUP BY workspace_id` : Promise.resolve([]),
    ]);
    const adminIds = [...new Set(roles.filter((r) => r.role === "WORKSPACE_ADMIN" && r.principalType === "user").map((r) => r.principalId))];
    const people = new Map((await tx.user.findMany({ where: { id: { in: adminIds } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u]));
    const budgetCount = new Map(budgets.map((b) => [b.workspaceId, b._count._all]));
    const lastAt = new Map(activity.map((a) => [a.workspace_id, a.at]));
    return {
      workspaces: rows.map((w) => {
        const here = roles.filter((r) => r.workspaceId === w.id);
        return {
          id: w.id,
          name: w.name,
          slug: w.slug,
          currency: w.reportingCurrency,
          fiscalYearStartMonth: w.fiscalYearStartMonth,
          status: w.status === "ARCHIVED" ? ("ARCHIVED" as const) : ("ACTIVE" as const),
          archivedAt: w.archivedAt?.toISOString() ?? null,
          deletedAt: null,
          purgeAfter: null,
          createdAt: w.createdAt.toISOString(),
          members: new Set(here.map((r) => `${r.principalType}:${r.principalId}`)).size,
          budgets: budgetCount.get(w.id) ?? 0,
          lastActivityAt: lastAt.get(w.id) ? new Date(lastAt.get(w.id) as Date).toISOString() : null,
          admins: here.filter((r) => r.role === "WORKSPACE_ADMIN" && r.principalType === "user").flatMap((r) => (people.has(r.principalId) ? [people.get(r.principalId) as { id: string; name: string; email: string }] : [])),
        };
      }),
    };
  });
}

/** PATCH /workspaces/:ws { status } — archive (read-only, hidden from its members) or restore. */
export async function setWorkspaceStatus(prisma: PrismaClient, auth: AuthContext, raw: unknown, now: Date = new Date()) {
  superadminOnly(auth);
  const input = parseInput(UpdateWorkspaceStatusInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, orgCtx(auth, workspaceId), async (tx) => {
    const before = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { status: true, deletedAt: true, name: true } });
    if (before.deletedAt !== null) throw new DomainError("CONFLICT", "This workspace is deleted: undelete it first");
    if (before.status === input.status) return { id: workspaceId, status: input.status, changed: false };
    const archived = input.status === "ARCHIVED";
    await tx.workspace.update({ where: { id: workspaceId }, data: archived ? { status: "ARCHIVED", archivedAt: now, archivedBy: auth.user.id } : { status: "ACTIVE", archivedAt: null, archivedBy: null } });
    await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: archived ? "workspace.archived" : "workspace.restored", entityType: "workspace", entityId: workspaceId, before: { status: before.status }, after: { status: input.status }, ...(input.reason ? { reason: input.reason } : {}), requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId, topic: "workspace.changed", payload: { workspaceId, status: input.status } });
    return { id: workspaceId, status: input.status, changed: true };
  });
}

/**
 * DELETE /workspaces/:ws { confirmName, reason } — only an archived workspace, only with its exact
 * name. The row stays as a tombstone, its slug is freed, and the purge worker removes its rows after
 * the retention window (WORKSPACE_RETENTION_DAYS, default 30).
 */
export async function deleteWorkspace(prisma: PrismaClient, auth: AuthContext, raw: unknown, now: Date = new Date()) {
  superadminOnly(auth);
  const input = parseInput(DeleteWorkspaceInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, orgCtx(auth, workspaceId), async (tx) => {
    const ws = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true, slug: true, status: true, deletedAt: true } });
    if (ws.deletedAt !== null) throw new DomainError("CONFLICT", "This workspace is already deleted");
    if (ws.status !== "ARCHIVED") throw new DomainError("CONFLICT", "Archive the workspace before deleting it");
    if (input.confirmName.trim() !== ws.name) throw new DomainError("VALIDATION", "Type the workspace's name exactly to delete it", { field: "confirmName" });
    const purgeAfter = new Date(now.getTime() + retentionDays() * 86_400_000);
    await tx.workspace.update({ where: { id: workspaceId }, data: { deletedAt: now, purgeAfter, slug: `${ws.slug.slice(0, 40)}--deleted-${workspaceId.slice(-8)}` } });
    await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "workspace.deleted", entityType: "workspace", entityId: workspaceId, before: { name: ws.name, slug: ws.slug }, after: { purgeAfter: purgeAfter.toISOString() }, reason: input.reason, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId, topic: "workspace.deleted", payload: { workspaceId, purgeAfter: purgeAfter.toISOString() } });
    return { id: workspaceId, deleted: true, purgeAfter: purgeAfter.toISOString() };
  });
}

/** POST /workspaces/:ws/undelete — within the retention window, the workspace comes back archived. */
export async function undeleteWorkspace(prisma: PrismaClient, auth: AuthContext, now: Date = new Date()) {
  superadminOnly(auth);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, orgCtx(auth, workspaceId), async (tx) => {
    const ws = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { slug: true, deletedAt: true, purgedAt: true, orgId: true } });
    if (ws.deletedAt === null) throw new DomainError("CONFLICT", "This workspace is not deleted");
    if (ws.purgedAt !== null) throw new DomainError("CONFLICT", "This workspace's data has been purged; it cannot come back");
    const original = ws.slug.replace(/--deleted-[0-9a-f]{8}$/, "");
    const taken = await tx.workspace.findFirst({ where: { orgId: ws.orgId, slug: original, id: { not: workspaceId } }, select: { id: true } });
    const slug = taken ? `${original.slice(0, 40)}-${workspaceId.slice(-6)}` : original;
    await tx.workspace.update({ where: { id: workspaceId }, data: { deletedAt: null, purgeAfter: null, slug, status: "ARCHIVED" } });
    await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "workspace.undeleted", entityType: "workspace", entityId: workspaceId, after: { slug, status: "ARCHIVED" }, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId, topic: "workspace.changed", payload: { workspaceId, status: "ARCHIVED", undeleted: true, at: now.toISOString() } });
    return { id: workspaceId, status: "ARCHIVED" as const, slug };
  });
}
