import { withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";

export function listRoles(prisma: PrismaClient, auth: AuthContext) {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, (tx) => tx.roleAssignment.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } }));
}
