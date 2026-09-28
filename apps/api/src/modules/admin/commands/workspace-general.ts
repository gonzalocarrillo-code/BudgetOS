import { DomainError, UpdateWorkspaceInput } from "@budget/domain";
import { audit, outbox, withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";

/** Settings › Workspace (product feedback 2026-09-28): the workspace's name and what identifies it. */

/** GET /workspaces/:ws/general */
export async function getWorkspaceGeneral(prisma: PrismaClient, auth: AuthContext) {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const w = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { id: true, name: true, slug: true, reportingCurrency: true, fiscalYearStartMonth: true, createdAt: true } });
    return { id: w.id, name: w.name, slug: w.slug, reportingCurrency: w.reportingCurrency, fiscalYearStartMonth: w.fiscalYearStartMonth, createdAt: w.createdAt.toISOString() };
  });
}

/** PATCH /workspaces/:ws/general: rename the workspace. One audit_event + one outbox row. */
export async function updateWorkspaceGeneral(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = parseInput(UpdateWorkspaceInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const before = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true, orgId: true } });
    const clash = await tx.workspace.findFirst({ where: { orgId: before.orgId, name: input.name, id: { not: workspaceId } }, select: { id: true } });
    if (clash) throw new DomainError("CONFLICT", "Another workspace in this organization has that name");
    await tx.workspace.update({ where: { id: workspaceId }, data: { name: input.name } });
    await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "workspace.renamed", entityType: "workspace", entityId: workspaceId, before: { name: before.name }, after: { name: input.name }, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId, topic: "workspace.changed", payload: { workspaceId, name: input.name } });
    return getWorkspaceGeneral(prisma, auth).then((g) => ({ ...g, name: input.name }));
  });
}
