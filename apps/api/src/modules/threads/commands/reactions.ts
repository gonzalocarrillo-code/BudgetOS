import { DomainError, ReactionInput, type AnchorType } from "@budget/domain";
import { audit, outbox, withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseId, parseInput } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { assertCanRead, resolveAnchor } from "../anchor.js";

/**
 * Emoji reactions (plan §8.6, 0.6, ADR-025): each by one account, one per (comment, account, emoji).
 * Adding twice or removing a reaction that is not there changes nothing and writes nothing.
 * Every change is one audit_event and one `thread.changed` outbox row (no mentions: no notification).
 */
async function react(prisma: PrismaClient, auth: AuthContext, rawCommentId: string, raw: unknown, mode: "add" | "remove") {
  const { emoji } = parseInput(ReactionInput, raw);
  const commentId = parseId(rawCommentId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const c = await tx.comment.findUnique({ where: { id: commentId }, include: { thread: true } });
    if (c === null || c.deletedAt) throw new DomainError("NOT_FOUND", "Comment not found");
    assertCanRead(auth, await resolveAnchor(tx, c.thread.workspaceId, c.thread.anchorType as AnchorType, c.thread.anchorId));
    const key = { commentId_userId_emoji: { commentId, userId: auth.user.id, emoji } };
    const exists = (await tx.commentReaction.findUnique({ where: key })) !== null;
    if (mode === "add" && !exists) await tx.commentReaction.create({ data: { commentId, userId: auth.user.id, emoji, workspaceId: c.thread.workspaceId } });
    if (mode === "remove" && exists) await tx.commentReaction.delete({ where: key });
    const changed = mode === "add" ? !exists : exists;
    if (changed) {
      const action = mode === "add" ? "reaction.added" : "reaction.removed";
      await audit(tx, { workspaceId: c.thread.workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action, entityType: "comment", entityId: commentId, after: { emoji }, requestId: auth.ctx.requestId });
      await outbox(tx, { workspaceId: c.thread.workspaceId, topic: "thread.changed", payload: { threadId: c.threadId, commentId, action, emoji, actorId: auth.user.id, anchorType: c.thread.anchorType, anchorId: c.thread.anchorId, mentions: [] } });
    }
    const count = await tx.commentReaction.count({ where: { commentId, emoji } });
    return { commentId, emoji, mine: mode === "add", count, changed };
  });
}

/** POST /comments/:id/reactions { emoji } */
export const addReaction = (prisma: PrismaClient, auth: AuthContext, id: string, raw: unknown) => react(prisma, auth, id, raw, "add");
/** DELETE /comments/:id/reactions { emoji } */
export const removeReaction = (prisma: PrismaClient, auth: AuthContext, id: string, raw: unknown) => react(prisma, auth, id, raw, "remove");
