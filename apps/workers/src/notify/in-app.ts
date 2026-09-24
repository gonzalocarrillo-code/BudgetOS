import { insertNotification, subscribers } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { decodePush, handleOnce, type OutboxEvent } from "../consumer.js";

export const IN_APP_CONSUMER = "notify-in-app";

/** The `thread.changed` outbox payload the threads module writes (spec §13). */
const ThreadChanged = z.object({
  threadId: z.string().uuid(),
  commentId: z.string().uuid().nullable(),
  action: z.string(),
  actorId: z.string().uuid(),
  anchorType: z.string(),
  anchorId: z.string().uuid(),
  mentions: z.array(z.object({ type: z.enum(["user", "group"]), id: z.string().uuid() })),
});

/** Actions that tell a thread's followers something happened. Edits and deletions only notify new mentions. */
const ACTIVITY = new Set(["thread.created", "comment.added", "thread.resolved", "thread.reopened"]);

/**
 * notify-worker, in-app channel (spec §19): mentioned users and members of mentioned groups get a
 * `mention`; followers of the thread or its anchor get `thread_activity`. One notification per
 * user per event, never to the author, and once per outbox event however often it is delivered.
 * Slack and email deliveries are T-021.
 */
export async function handleThreadChanged(prisma: PrismaClient, body: unknown): Promise<{ outcome: "applied" | "duplicate"; notified: string[] }> {
  const event: OutboxEvent = decodePush(body);
  const p = ThreadChanged.parse(event.payload);
  const notified: string[] = [];
  const outcome = await handleOnce(prisma, IN_APP_CONSUMER, event, async (tx) => {
    const groupIds = p.mentions.filter((m) => m.type === "group").map((m) => m.id);
    const members = groupIds.length ? (await tx.groupMember.findMany({ where: { groupId: { in: groupIds } }, select: { userId: true } })).map((m) => m.userId) : [];
    const mentioned = new Set([...p.mentions.filter((m) => m.type === "user").map((m) => m.id), ...members]);
    const followers = ACTIVITY.has(p.action) ? await subscribers(tx, [{ type: "thread", id: p.threadId }, { type: p.anchorType, id: p.anchorId }]) : [];
    const kinds = new Map<string, "mention" | "thread_activity">();
    for (const u of followers) kinds.set(u, "thread_activity");
    for (const u of mentioned) kinds.set(u, "mention"); // a mention wins over activity
    kinds.delete(p.actorId);
    for (const [userId, kind] of [...kinds.entries()].sort()) {
      await insertNotification(tx, { workspaceId: event.workspaceId, userId, kind, payload: { threadId: p.threadId, commentId: p.commentId, action: p.action, actorId: p.actorId, anchorType: p.anchorType, anchorId: p.anchorId, outboxId: event.outboxId } });
      notified.push(userId);
    }
  });
  return { outcome, notified: outcome === "applied" ? notified : [] };
}
