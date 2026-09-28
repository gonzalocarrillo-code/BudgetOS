import { AddPersonInput, DomainError, newId } from "@budget/domain";
import { audit, outbox, withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseInput, requireWorkspace } from "../../../common/parse-input.js";
import { orgAdminCtx, type AuthContext } from "../../../common/tenant.js";

/**
 * POST /workspaces/:ws/members: adds a person to the workspace's org by email, so a role can be
 * given before they first sign in (sign-in matches a verified email to this user). An email already
 * in the org returns that person; one in another org is refused. People belong to the org, so only
 * an org admin adds them (RLS lets only org-level calls write app_user).
 */
export async function addPerson(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = parseInput(AddPersonInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  if (!auth.isOrgAdmin) throw new DomainError("FORBIDDEN", "Only an org admin adds people to the organisation");
  return withTenant(prisma, { ...orgAdminCtx(auth), workspaceId, isOrgAdmin: true }, async (tx) => {
    const ws = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { orgId: true } });
    const existing = await tx.user.findUnique({ where: { email: input.email } });
    if (existing) {
      if (existing.orgId !== ws.orgId) throw new DomainError("CONFLICT", "That email belongs to another organisation", { email: input.email });
      return { id: existing.id, email: existing.email, name: existing.name, created: false };
    }
    // Someone in another org is invisible here (RLS), so the lookup above misses them: the unique email says so.
    const user = await tx.user.create({ data: { id: newId(), orgId: ws.orgId, email: input.email, name: input.name } }).catch((e: unknown) => {
      if ((e as { code?: string }).code === "P2002") throw new DomainError("CONFLICT", "That email belongs to another organisation", { email: input.email });
      throw e;
    });
    await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "user.added", entityType: "user", entityId: user.id, after: { email: user.email, name: user.name }, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId, topic: "user.added", payload: { userId: user.id } });
    return { id: user.id, email: user.email, name: user.name, created: true };
  });
}
