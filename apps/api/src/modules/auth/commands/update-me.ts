import { UpdateMeInput } from "@budget/domain";
import { audit, outbox, setMyName, withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";

/** PATCH /me: the caller's display name. One audit_event and one `user.updated` outbox row. */
export async function updateMe(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = parseInput(UpdateMeInput, raw);
  // Recorded in the workspace the person renamed themselves from (the outbox is per workspace).
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const before = auth.user.name;
    const name = await setMyName(tx, input.name);
    await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "user.renamed", entityType: "app_user", entityId: auth.user.id, before: { name: before }, after: { name }, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId, topic: "user.updated", payload: { userId: auth.user.id } });
    return { id: auth.user.id, name };
  });
}
