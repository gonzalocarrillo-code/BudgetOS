import { CommentInput, CreateThreadInput, DomainError, SubscriptionInput, UpdateCommentInput, extractMentions, newId, type AnchorType, type Mention } from "@budget/domain";
import { audit, outbox, setSubscription, withTenant, type Tx } from "@budget/db";
import type { Prisma, PrismaClient, Thread } from "@prisma/client";
import { parseId, parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { assertCanRead, isEligibleApprover, resolveAnchor } from "../anchor.js";

/**
 * Threads and comments (spec §13). Every create / edit / delete / resolve / reopen writes one
 * audit_event and one `thread.changed` outbox row; notify-worker turns mentions and subscriptions
 * into notifications (never from the request). Comments are soft-deleted, never removed.
 */

const json = (v: unknown) => v as Prisma.InputJsonValue;
/** Anchors whose blocking threads block a submit (envelopes: spec §7.2; targets: spec §10). */
const BLOCKABLE: AnchorType[] = ["envelope", "target"];

async function record(tx: Tx, auth: AuthContext, thread: Pick<Thread, "id" | "workspaceId" | "anchorType" | "anchorId">, action: string, after: Record<string, unknown>, mentions: Mention[] = [], commentId: string | null = null) {
  await audit(tx, { workspaceId: thread.workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action, entityType: "thread", entityId: thread.id, after: { commentId, ...after }, requestId: auth.ctx.requestId });
  await outbox(tx, { workspaceId: thread.workspaceId, topic: "thread.changed", payload: { threadId: thread.id, commentId, action, actorId: auth.user.id, anchorType: thread.anchorType, anchorId: thread.anchorId, mentions } });
}

/**
 * Mentioned users must hold a role in this workspace (directly or through a group), so a mention
 * never notifies someone who cannot open the workspace; mentioned groups must be the org's.
 */
async function checkMentions(tx: Tx, workspaceId: string, mentions: Mention[]): Promise<void> {
  const userIds = mentions.filter((m) => m.type === "user").map((m) => m.id);
  const groupIds = mentions.filter((m) => m.type === "group").map((m) => m.id);
  if (groupIds.length) {
    const found = await tx.group.findMany({ where: { id: { in: groupIds } }, select: { id: true } });
    const missing = groupIds.filter((id) => !found.some((g) => g.id === id));
    if (missing.length) throw new DomainError("VALIDATION", "Unknown groups mentioned", { groups: missing });
  }
  if (userIds.length === 0) return;
  const groups = await tx.groupMember.findMany({ where: { userId: { in: userIds } }, select: { userId: true, groupId: true } });
  const roles = await tx.roleAssignment.findMany({
    where: {
      OR: [{ workspaceId }, { workspaceId: null }],
      AND: [{ OR: [{ principalType: "user", principalId: { in: userIds } }, { principalType: "group", principalId: { in: groups.map((g) => g.groupId) } }] }],
    },
    select: { principalType: true, principalId: true },
  });
  const hasRole = (u: string) => roles.some((r) => (r.principalType === "user" && r.principalId === u) || (r.principalType === "group" && groups.some((g) => g.userId === u && g.groupId === r.principalId)));
  const outside = userIds.filter((u) => !hasRole(u));
  if (outside.length) throw new DomainError("VALIDATION", "Mentioned users have no access to this workspace", { users: outside });
}

async function loadThread(tx: Tx, rawId: string): Promise<Thread> {
  const t = await tx.thread.findUnique({ where: { id: parseId(rawId) } });
  if (t === null) throw new DomainError("NOT_FOUND", "Thread not found");
  return t;
}

async function insertComment(tx: Tx, auth: AuthContext, thread: Thread, input: CommentInput) {
  const { mentions, references } = extractMentions(input.bodyMd);
  await checkMentions(tx, thread.workspaceId, mentions);
  if (input.parentCommentId) {
    const parent = await tx.comment.findUnique({ where: { id: input.parentCommentId }, select: { threadId: true } });
    if (parent?.threadId !== thread.id) throw new DomainError("VALIDATION", "parentCommentId is not a comment of this thread");
  }
  const comment = await tx.comment.create({
    data: { id: newId(), threadId: thread.id, parentCommentId: input.parentCommentId ?? null, authorId: auth.user.id, bodyMd: input.bodyMd, mentions: json(mentions), references: json(references), attachments: json(input.attachments) },
  });
  // The author follows the thread from their first comment on.
  await setSubscription(tx, { workspaceId: thread.workspaceId, userId: auth.user.id, entityType: "thread", entityId: thread.id, subscribed: true });
  return { comment, mentions };
}

/** POST /threads */
export async function createThread(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = parseInput(CreateThreadInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  if (input.isBlocking && !BLOCKABLE.includes(input.anchorType)) throw new DomainError("VALIDATION", "Only envelope and target threads can block a submit", { anchorType: input.anchorType });
  if (input.anchorType === "cell" && input.anchorMeta.month === undefined) throw new DomainError("VALIDATION", "A cell thread needs anchorMeta.month");
  if (input.anchorType === "diff_field" && input.anchorMeta.field === undefined) throw new DomainError("VALIDATION", "A diff_field thread needs anchorMeta.field");
  return withTenant(prisma, auth.ctx, async (tx) => {
    assertCanRead(auth, await resolveAnchor(tx, workspaceId, input.anchorType, input.anchorId));
    const thread = await tx.thread.create({
      data: { id: newId(), workspaceId, anchorType: input.anchorType, anchorId: input.anchorId, anchorMeta: json(input.anchorMeta), title: input.title ?? null, isBlocking: input.isBlocking, createdBy: auth.user.id },
    });
    const { comment, mentions } = await insertComment(tx, auth, thread, input.firstComment);
    await record(tx, auth, thread, "thread.created", { isBlocking: thread.isBlocking, title: thread.title }, mentions, comment.id);
    return { ...thread, createdAt: thread.createdAt.toISOString(), comments: [{ id: comment.id, bodyMd: comment.bodyMd, mentions }] };
  });
}

/** POST /threads/:id/comments */
export async function addComment(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const input = parseInput(CommentInput, raw);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const thread = await loadThread(tx, rawId);
    assertCanRead(auth, await resolveAnchor(tx, thread.workspaceId, thread.anchorType as AnchorType, thread.anchorId));
    if (thread.status !== "open") throw new DomainError("CONFLICT", "Thread is resolved; reopen it to comment");
    const { comment, mentions } = await insertComment(tx, auth, thread, input);
    await record(tx, auth, thread, "comment.added", {}, mentions, comment.id);
    return { id: comment.id, threadId: thread.id, bodyMd: comment.bodyMd, mentions, createdAt: comment.createdAt.toISOString() };
  });
}

/** PATCH /comments/:id: author only. The previous body is kept in edit_history; only new mentions notify. */
export async function editComment(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const input = parseInput(UpdateCommentInput, raw);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const c = await tx.comment.findUnique({ where: { id: parseId(rawId) }, include: { thread: true } });
    if (c === null) throw new DomainError("NOT_FOUND", "Comment not found");
    if (c.authorId !== auth.user.id) throw new DomainError("FORBIDDEN", "Only the author edits a comment");
    if (c.deletedAt) throw new DomainError("CONFLICT", "Comment is deleted");
    const { mentions, references } = extractMentions(input.bodyMd);
    await checkMentions(tx, c.thread.workspaceId, mentions);
    const before = (c.mentions ?? []) as unknown as Mention[];
    const added = mentions.filter((m) => !before.some((b) => b.type === m.type && b.id === m.id));
    const history = [...((c.editHistory ?? []) as unknown[]), { bodyMd: c.bodyMd, editedAt: (c.editedAt ?? c.createdAt).toISOString() }];
    const row = await tx.comment.update({ where: { id: c.id }, data: { bodyMd: input.bodyMd, mentions: json(mentions), references: json(references), editHistory: json(history), editedAt: new Date() } });
    await record(tx, auth, c.thread, "comment.edited", { revisions: history.length }, added, c.id);
    return { id: row.id, bodyMd: row.bodyMd, mentions, editedAt: row.editedAt?.toISOString() ?? null, revisions: history.length };
  });
}

/** DELETE /comments/:id: the author or a workspace admin. Soft delete: the body stays in the row, hidden on read. */
export async function deleteComment(prisma: PrismaClient, auth: AuthContext, rawId: string) {
  return withTenant(prisma, auth.ctx, async (tx) => {
    const c = await tx.comment.findUnique({ where: { id: parseId(rawId) }, include: { thread: true } });
    if (c === null) throw new DomainError("NOT_FOUND", "Comment not found");
    const admin = auth.isOrgAdmin || auth.roles.includes("WORKSPACE_ADMIN");
    if (c.authorId !== auth.user.id && !admin) throw new DomainError("FORBIDDEN", "Only the author or a workspace admin deletes a comment");
    if (c.deletedAt) return { id: c.id, deletedAt: c.deletedAt.toISOString() };
    const row = await tx.comment.update({ where: { id: c.id }, data: { deletedAt: new Date() } });
    await record(tx, auth, c.thread, "comment.deleted", {}, [], c.id);
    return { id: row.id, deletedAt: row.deletedAt?.toISOString() ?? null };
  });
}

/**
 * Resolve / reopen (spec §13 `thread.resolve`): the thread's author, an owner of the anchor, an
 * eligible approver of an open request on the anchor, or a workspace admin. Resolving a blocking
 * thread lets the anchor's submit through again.
 */
async function setStatus(prisma: PrismaClient, auth: AuthContext, rawId: string, to: "resolved" | "open") {
  return withTenant(prisma, auth.ctx, async (tx) => {
    const thread = await loadThread(tx, rawId);
    const anchor = await resolveAnchor(tx, thread.workspaceId, thread.anchorType as AnchorType, thread.anchorId);
    assertCanRead(auth, anchor);
    if (thread.status === to) throw new DomainError("CONFLICT", `Thread is already ${to}`);
    const allowed =
      auth.isOrgAdmin ||
      auth.roles.includes("WORKSPACE_ADMIN") ||
      thread.createdBy === auth.user.id ||
      anchor.ownerIds.includes(auth.user.id) ||
      (await isEligibleApprover(tx, auth, anchor.openRequestIds));
    if (!allowed) throw new DomainError("FORBIDDEN", "Only the thread's author, the anchor's owner or an eligible approver can do this");
    const row = await tx.thread.update({
      where: { id: thread.id },
      data: to === "resolved" ? { status: "resolved", resolvedBy: auth.user.id, resolvedAt: new Date() } : { status: "open", resolvedBy: null, resolvedAt: null },
    });
    await record(tx, auth, thread, to === "resolved" ? "thread.resolved" : "thread.reopened", { isBlocking: thread.isBlocking });
    return { id: row.id, status: row.status, resolvedBy: row.resolvedBy, resolvedAt: row.resolvedAt?.toISOString() ?? null };
  });
}
export const resolveThread = (prisma: PrismaClient, auth: AuthContext, rawId: string) => setStatus(prisma, auth, rawId, "resolved");
export const reopenThread = (prisma: PrismaClient, auth: AuthContext, rawId: string) => setStatus(prisma, auth, rawId, "open");

/** POST /subscriptions: follow or stop following an entity's threads. */
export async function subscribe(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = parseInput(SubscriptionInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    if (input.entityType === "thread") {
      const t = await tx.thread.findUnique({ where: { id: input.entityId } });
      if (t === null || t.workspaceId !== workspaceId) throw new DomainError("NOT_FOUND", "Thread not found");
      assertCanRead(auth, await resolveAnchor(tx, workspaceId, t.anchorType as AnchorType, t.anchorId));
    } else {
      assertCanRead(auth, await resolveAnchor(tx, workspaceId, input.entityType, input.entityId));
    }
    const changed = await setSubscription(tx, { workspaceId, userId: auth.user.id, ...input });
    if (changed) {
      await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: input.subscribed ? "subscription.created" : "subscription.deleted", entityType: input.entityType, entityId: input.entityId, after: { userId: auth.user.id }, requestId: auth.ctx.requestId });
      await outbox(tx, { workspaceId, topic: "subscription.changed", payload: { userId: auth.user.id, ...input } });
    }
    return { ...input, changed };
  });
}
