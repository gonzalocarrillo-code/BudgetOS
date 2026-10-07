import { DomainError, InviteOrgPersonInput, SetWorkspaceRolesInput, newId, type InviteOrgPersonResult, type Role, type SetWorkspaceRolesResult } from "@budget/domain";
import { audit, outbox, withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseId, parseInput } from "../../common/parse-input.js";
import type { AuthContext } from "../../common/tenant.js";

/**
 * Round 11 (PR 3): the org console manages who is in which workspace. `POST /org/people` invites
 * someone (always into one workspace with a role: decision D4). `PUT /org/people/:id/workspaces/:ws`
 * sets a person's direct roles in one workspace (an empty list removes them from it). Both are
 * superadmin-only and run with the org-admin session for the target workspace, the same way
 * `setWorkspaceStatus` (lifecycle.ts) does.
 */
const wsCtx = (auth: AuthContext, workspaceId: string) => ({ ...auth.ctx, workspaceId, isOrgAdmin: true, actingAs: "superadmin" as const });

function superadminOnly(auth: AuthContext): void {
  if (!auth.isOrgAdmin) throw new DomainError("FORBIDDEN", "Only a superadmin manages workspace membership");
}

/**
 * PUT /org/people/:id/workspaces/:wsId { roles } — the person's direct roles in `wsId` become
 * exactly `roles`. Roles that stay keep their existing scope; only the difference is written, so
 * one audit_event + one outbox row per added or removed role, never a churn of unrelated rows.
 */
export async function setWorkspaceRoles(prisma: PrismaClient, auth: AuthContext, rawUserId: string, rawWs: string, raw: unknown): Promise<SetWorkspaceRolesResult> {
  superadminOnly(auth);
  const userId = parseId(rawUserId);
  const workspaceId = parseId(rawWs);
  const input = parseInput(SetWorkspaceRolesInput, raw);
  const roles = [...new Set(input.roles)] as Role[];
  return withTenant(prisma, wsCtx(auth, workspaceId), async (tx) => {
    const ws = await tx.workspace.findFirst({ where: { id: workspaceId, orgId: auth.user.orgId }, select: { deletedAt: true, status: true } });
    if (ws === null) throw new DomainError("NOT_FOUND", "Workspace not found");
    if (ws.deletedAt !== null) throw new DomainError("NOT_FOUND", "Workspace not found");
    if (ws.status === "ARCHIVED") throw new DomainError("LOCKED", "This workspace is archived: restore it to make changes", { archived: true });
    const user = await tx.user.findFirst({ where: { id: userId, orgId: auth.user.orgId }, select: { id: true, isActive: true } });
    if (user === null) throw new DomainError("NOT_FOUND", "Person not found");
    if (!user.isActive && roles.length > 0) throw new DomainError("CONFLICT", "Turn their access back on first");

    const current = await tx.roleAssignment.findMany({ where: { workspaceId, principalType: "user", principalId: userId } });
    const toRemove = current.filter((r) => !roles.includes(r.role as Role));
    const toAdd = roles.filter((r) => !current.some((c) => c.role === r));

    // ORG-005: a workspace keeps at least one admin (same rule and message as revoke-role.ts).
    const removingAdmin = toRemove.filter((r) => r.role === "WORKSPACE_ADMIN").length;
    if (removingAdmin > 0) {
      const adminCount = await tx.roleAssignment.count({ where: { workspaceId, role: "WORKSPACE_ADMIN" } });
      if (adminCount - removingAdmin < 1) {
        throw new DomainError("CONFLICT", "A workspace needs at least one admin. Give someone else the Workspace admin role first.", { lastAdmin: true });
      }
    }

    for (const row of toRemove) {
      await tx.roleAssignment.delete({ where: { id: row.id } });
      const before = { principalType: row.principalType, principalId: row.principalId, role: row.role, scope: row.scope };
      await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "role.revoked", entityType: "role_assignment", entityId: row.id, before, requestId: auth.ctx.requestId });
      await outbox(tx, { workspaceId, topic: "access.changed", payload: { kind: "role.revoked", roleAssignmentId: row.id, ...before } });
    }
    for (const role of toAdd) {
      const id = newId();
      await tx.roleAssignment
        .create({ data: { id, workspaceId, principalType: "user", principalId: userId, role, scope: {}, createdBy: auth.user.id } })
        .catch((e: unknown) => {
          // role_assignment_unique_scoped (W3-3): a concurrent call already added this role.
          if ((e as { code?: string }).code === "P2002") throw new DomainError("CONFLICT", "That role was just given by someone else", { role });
          throw e;
        });
      const after = { principalType: "user", principalId: userId, role, scope: {} };
      await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "role.assigned", entityType: "role_assignment", entityId: id, after, requestId: auth.ctx.requestId });
      await outbox(tx, { workspaceId, topic: "access.changed", payload: { kind: "role.assigned", roleAssignmentId: id, ...after } });
    }

    return { userId, workspaceId, roles: roles.sort(), added: toAdd.sort(), removed: toRemove.map((r) => r.role).sort() };
  });
}

/**
 * POST /org/people — a superadmin adds someone to the org, always into one workspace with a role
 * (D4: the per-workspace audit row every write path needs requires a workspace).
 */
export async function inviteOrgPerson(prisma: PrismaClient, auth: AuthContext, raw: unknown): Promise<InviteOrgPersonResult> {
  superadminOnly(auth);
  const input = parseInput(InviteOrgPersonInput, raw);
  // Check the workspace before creating anyone: a bad or archived workspace must not leave behind
  // a user with a 'user.added' audit row and no role to show for it.
  await withTenant(prisma, wsCtx(auth, input.workspaceId), async (tx) => {
    const ws = await tx.workspace.findFirst({ where: { id: input.workspaceId, orgId: auth.user.orgId }, select: { deletedAt: true, status: true } });
    if (ws === null || ws.deletedAt !== null) throw new DomainError("NOT_FOUND", "Workspace not found");
    if (ws.status === "ARCHIVED") throw new DomainError("LOCKED", "This workspace is archived: restore it to make changes", { archived: true });
  });
  const person = await withTenant(prisma, { ...auth.ctx, workspaceId: null, isOrgAdmin: true, actingAs: "superadmin" as const }, async (tx) => {
    const existing = await tx.user.findUnique({ where: { email: input.email } });
    if (existing) {
      if (existing.orgId !== auth.user.orgId) throw new DomainError("CONFLICT", "That email belongs to another organisation", { email: input.email });
      return { id: existing.id, email: existing.email, name: existing.name, created: false };
    }
    const user = await tx.user.create({ data: { id: newId(), orgId: auth.user.orgId, email: input.email, name: input.name } }).catch((e: unknown) => {
      if ((e as { code?: string }).code === "P2002") throw new DomainError("CONFLICT", "That email belongs to another organisation", { email: input.email });
      throw e;
    });
    await audit(tx, { workspaceId: input.workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "user.added", entityType: "user", entityId: user.id, after: { email: user.email, name: user.name }, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId: input.workspaceId, topic: "user.added", payload: { userId: user.id } });
    return { id: user.id, email: user.email, name: user.name, created: true };
  });
  await setWorkspaceRoles(prisma, auth, person.id, input.workspaceId, { roles: [input.role] });
  return { id: person.id, email: person.email, name: person.name, created: person.created };
}
