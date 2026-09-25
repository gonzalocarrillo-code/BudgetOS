import { CreateSavedViewInput, DomainError, UpdateSavedViewInput, can, newId } from "@budget/domain";
import { audit, outbox, withTenant, type Tx } from "@budget/db";
import type { Prisma, PrismaClient, SavedView } from "@prisma/client";
import { parseId, parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { savedViewView } from "../views.js";

/** Saved views (spec §17 `views`). Each write: one audit_event + one `view.changed` outbox row. */

const json = (v: unknown) => v as Prisma.InputJsonValue;

function assertMayShare(auth: AuthContext, visibility: string | undefined): void {
  if (visibility === "workspace" && !auth.isOrgAdmin && !can(auth.roles, "view.share_workspace")) {
    throw new DomainError("FORBIDDEN", "Sharing a view with the workspace needs view.share_workspace", { permission: "view.share_workspace" });
  }
}

async function record(tx: Tx, auth: AuthContext, v: { id: string; workspaceId: string }, action: string, after: Record<string, unknown>, before: unknown = null) {
  await audit(tx, { workspaceId: v.workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action, entityType: "saved_view", entityId: v.id, before, after, requestId: auth.ctx.requestId });
  await outbox(tx, { workspaceId: v.workspaceId, topic: "view.changed", payload: { savedViewId: v.id, action } });
}

/** POST /workspaces/:ws/saved-views. */
export async function createSavedView(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = parseInput(CreateSavedViewInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  assertMayShare(auth, input.visibility);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const v = await tx.savedView.create({ data: { id: newId(), workspaceId, name: input.name, screen: input.screen, definition: json(input.definition), visibility: input.visibility, createdBy: auth.user.id } });
    await record(tx, auth, v, "saved_view.created", { name: v.name, screen: v.screen, visibility: v.visibility });
    return savedViewView(v);
  });
}

async function own(tx: Tx, auth: AuthContext, rawId: string): Promise<SavedView> {
  const v = await tx.savedView.findUnique({ where: { id: parseId(rawId) } });
  if (v === null || (v.createdBy !== auth.user.id && v.visibility !== "workspace")) throw new DomainError("NOT_FOUND", "Saved view not found");
  if (v.createdBy !== auth.user.id && !auth.isOrgAdmin && !can(auth.roles, "view.share_workspace")) throw new DomainError("FORBIDDEN", "Only the owner or a workspace admin changes this view");
  return v;
}

/** PATCH /saved-views/:id: the owner (or an admin, for a shared view). */
export async function updateSavedView(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const input = parseInput(UpdateSavedViewInput, raw);
  assertMayShare(auth, input.visibility);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const current = await own(tx, auth, rawId);
    const v = await tx.savedView.update({
      where: { id: current.id },
      data: { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.definition !== undefined ? { definition: json(input.definition) } : {}), ...(input.visibility !== undefined ? { visibility: input.visibility } : {}) },
    });
    await record(tx, auth, v, "saved_view.updated", { changed: Object.keys(input) }, savedViewView(current));
    return savedViewView(v);
  });
}

/** DELETE /saved-views/:id. A view is a bookmark, not a record: it is removed (the audit row keeps what it was). */
export async function deleteSavedView(prisma: PrismaClient, auth: AuthContext, rawId: string) {
  return withTenant(prisma, auth.ctx, async (tx) => {
    const current = await own(tx, auth, rawId);
    await tx.savedView.delete({ where: { id: current.id } });
    await record(tx, auth, current, "saved_view.deleted", { name: current.name }, savedViewView(current));
    return { id: current.id, deleted: true };
  });
}
