import { AddMemberInput, DomainError, newId, type Role } from "@budget/domain";
import { audit, outbox, withTenant } from "@budget/db";
import type { Prisma, PrismaClient } from "@prisma/client";
import { parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";

/**
 * POST /workspaces/:ws/members (ORG-005): a workspace admin adds someone to their workspace by work
 * email, with a role here, so they can sign in with Google and find it waiting. Someone new to the
 * org is created in the caller's org (the one elevated write, below); someone already in it is
 * found by exact email, never by browsing the org. The addition always carries a role here (Viewer
 * unless chosen) so the person shows on this workspace's Roles page (ADR-088: a person with no role
 * here would otherwise be invisible on the very page that just added them). An email in another org
 * is refused.
 */
export async function addPerson(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = parseInput(AddMemberInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const role: Role = input.role ?? "VIEWER";
  // app_user rows are org-level: RLS lets only the org-admin bypass write them. This transaction
  // does exactly one thing with it: create a person in the caller's own org.
  const person = await withTenant(prisma, { ...auth.ctx, workspaceId, isOrgAdmin: true }, async (tx) => {
    const existing = await tx.user.findUnique({ where: { email: input.email } });
    if (existing) {
      if (existing.orgId !== auth.user.orgId) throw new DomainError("CONFLICT", "That email belongs to another organisation", { email: input.email });
      return { id: existing.id, email: existing.email, name: existing.name, created: false };
    }
    // Someone in another org is invisible here (RLS), so the lookup above misses them: the unique email says so.
    const user = await tx.user.create({ data: { id: newId(), orgId: auth.user.orgId, email: input.email, name: input.name } }).catch((e: unknown) => {
      if ((e as { code?: string }).code === "P2002") throw new DomainError("CONFLICT", "That email belongs to another organisation", { email: input.email });
      throw e;
    });
    await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "user.added", entityType: "user", entityId: user.id, after: { email: user.email, name: user.name }, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId, topic: "user.added", payload: { userId: user.id } });
    return { id: user.id, email: user.email, name: user.name, created: true };
  });
  // The role, in the caller's own workspace session (RLS keeps it to this workspace).
  const assigned = await withTenant(prisma, auth.ctx, async (tx) => {
    const has = await tx.roleAssignment.findFirst({ where: { workspaceId, principalType: "user", principalId: person.id, role }, select: { id: true } });
    if (has) return has.id;
    const id = newId();
    await tx.roleAssignment.create({ data: { id, workspaceId, principalType: "user", principalId: person.id, role, scope: input.scope as Prisma.InputJsonObject, createdBy: auth.user.id } });
    const after = { principalType: "user", principalId: person.id, role, scope: input.scope };
    await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "role.assigned", entityType: "role_assignment", entityId: id, after, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId, topic: "access.changed", payload: { kind: "role.assigned", roleAssignmentId: id, ...after } });
    return id;
  });
  return { ...person, role, roleAssignmentId: assigned };
}
