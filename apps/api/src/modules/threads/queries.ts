import { ListThreadsQuery, PeopleQuery, REACTIONS, REACTION_NAMES, type Mention } from "@budget/domain";
import { withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseInput, requireWorkspace } from "../../common/parse-input.js";
import type { AuthContext } from "../../common/tenant.js";
import { assertCanRead, resolveAnchor } from "./anchor.js";
import { tagView } from "./views.js";

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
    const userIds: string[] = [...new Set([...threads.flatMap((t) => [t.createdBy, ...t.comments.map((c) => c.authorId)]), ...mentions.filter((m) => m.type === "user").map((m) => m.id)])];
    const groupIds = [...new Set(mentions.filter((m) => m.type === "group").map((m) => m.id))];
    const commentIds = threads.flatMap((t) => t.comments.map((c) => c.id));
    const reactions = commentIds.length ? await tx.commentReaction.findMany({ where: { commentId: { in: commentIds } }, orderBy: { createdAt: "asc" } }) : [];
    userIds.push(...reactions.map((r) => r.userId).filter((u) => !userIds.includes(u)));
    const users = Object.fromEntries((await tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    // Per comment and emoji: the count, who (by account), and whether the caller is one of them.
    const reactionsOf = (commentId: string) => {
      const mine = reactions.filter((r) => r.commentId === commentId);
      return REACTIONS.flatMap((emoji) => {
        const by = mine.filter((r) => r.emoji === emoji);
        return by.length ? [{ emoji, name: REACTION_NAMES[emoji], count: by.length, users: by.map((r) => ({ id: r.userId, name: users[r.userId] ?? "" })), mine: by.some((r) => r.userId === auth.user.id) }] : [];
      });
    };
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
        /** Earlier bodies, oldest first: every edit keeps the text it replaced (plan §8.6). */
        editHistory: c.deletedAt ? [] : ((c.editHistory ?? []) as Array<{ bodyMd: string; editedAt: string }>),
        reactions: c.deletedAt ? [] : reactionsOf(c.id),
      })),
      names: { users, groups },
    }));
  });
}

/** GET /workspaces/:ws/tags: with how many entities carry each. */
export function listTags(prisma: PrismaClient, auth: AuthContext) {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const tags = await tx.tag.findMany({ where: { workspaceId }, orderBy: { name: "asc" } });
    const counts = await tx.taggable.groupBy({ by: ["tagId"], where: { workspaceId }, _count: { _all: true } });
    return tags.map((t) => ({ ...tagView(t), count: counts.find((c) => c.tagId === t.id)?._count._all ?? 0 }));
  });
}

/**
 * GET /workspaces/:ws/people?q: who can be @mentioned here, the same rule the comment commands
 * enforce: an account with a role in this workspace (directly, org-wide, or through a group), and
 * the org's groups. Matched on name or email prefix, names first.
 */
export async function listPeople(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const q = parseInput(PeopleQuery, raw ?? {});
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const term = q.q.trim();
  return withTenant(prisma, auth.ctx, async (tx) => {
    const roles = await tx.roleAssignment.findMany({ where: { OR: [{ workspaceId }, { workspaceId: null }] }, select: { principalType: true, principalId: true } });
    const groupIds = roles.filter((r) => r.principalType === "group").map((r) => r.principalId);
    const members = groupIds.length ? await tx.groupMember.findMany({ where: { groupId: { in: groupIds } }, select: { userId: true } }) : [];
    const ids = [...new Set([...roles.filter((r) => r.principalType === "user").map((r) => r.principalId), ...members.map((m) => m.userId)])];
    const match = term ? { OR: [{ name: { contains: term, mode: "insensitive" as const } }, { email: { startsWith: term, mode: "insensitive" as const } }] } : {};
    const users = await tx.user.findMany({ where: { id: { in: ids }, orgId: auth.user.orgId, isActive: true, ...match }, select: { id: true, name: true, email: true }, orderBy: [{ name: "asc" }], take: q.limit });
    const groups = await tx.group.findMany({ where: { orgId: auth.user.orgId, ...(term ? { name: { contains: term, mode: "insensitive" as const } } : {}) }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: Math.max(0, q.limit - users.length) });
    return [...users.map((u) => ({ type: "user" as const, id: u.id, name: u.name, email: u.email })), ...groups.map((g) => ({ type: "group" as const, id: g.id, name: g.name, email: null }))];
  });
}
