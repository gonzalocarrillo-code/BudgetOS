import { ListThreadsQuery, type Mention } from "@budget/domain";
import { withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseInput, requireWorkspace } from "../../common/parse-input.js";
import type { AuthContext } from "../../common/tenant.js";
import { assertCanRead, resolveAnchor } from "./anchor.js";

/**
 * GET /threads?anchorType&anchorId: the anchor's threads, oldest first, with their comments.
 * Deleted comments keep their place with no body; display names of authors and mentions are
 * resolved here (spec §13: stored ids, names on read).
 */
export async function listThreads(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const q = parseInput(ListThreadsQuery, raw ?? {});
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    assertCanRead(auth, await resolveAnchor(tx, workspaceId, q.anchorType, q.anchorId));
    const threads = await tx.thread.findMany({ where: { workspaceId, anchorType: q.anchorType, anchorId: q.anchorId }, orderBy: { createdAt: "asc" }, include: { comments: { orderBy: { createdAt: "asc" } } } });
    const mentions = threads.flatMap((t) => t.comments.flatMap((c) => (c.mentions ?? []) as unknown as Mention[]));
    const userIds = [...new Set([...threads.flatMap((t) => [t.createdBy, ...t.comments.map((c) => c.authorId)]), ...mentions.filter((m) => m.type === "user").map((m) => m.id)])];
    const groupIds = [...new Set(mentions.filter((m) => m.type === "group").map((m) => m.id))];
    const users = Object.fromEntries((await tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    const groups = Object.fromEntries((await tx.group.findMany({ where: { id: { in: groupIds } }, select: { id: true, name: true } })).map((g) => [g.id, g.name]));
    return threads.map((t) => ({
      id: t.id,
      anchorType: t.anchorType,
      anchorId: t.anchorId,
      anchorMeta: t.anchorMeta,
      title: t.title,
      status: t.status,
      isBlocking: t.isBlocking,
      createdBy: t.createdBy,
      createdAt: t.createdAt.toISOString(),
      resolvedBy: t.resolvedBy,
      resolvedAt: t.resolvedAt?.toISOString() ?? null,
      comments: t.comments.map((c) => ({
        id: c.id,
        parentCommentId: c.parentCommentId,
        authorId: c.authorId,
        bodyMd: c.deletedAt ? null : c.bodyMd,
        mentions: c.deletedAt ? [] : c.mentions,
        references: c.deletedAt ? [] : c.references,
        attachments: c.deletedAt ? [] : c.attachments,
        createdAt: c.createdAt.toISOString(),
        editedAt: c.editedAt?.toISOString() ?? null,
        deletedAt: c.deletedAt?.toISOString() ?? null,
      })),
      names: { users, groups },
    }));
  });
}
