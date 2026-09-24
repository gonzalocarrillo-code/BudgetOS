import { eligibleApproverSql, insertNotification, subscribers, type Tx } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { decodePush, handleOnce, type OutboxEvent } from "../consumer.js";
import { approvalKind } from "./slack.js";

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

async function threadRecipients(tx: Tx, p: z.infer<typeof ThreadChanged>): Promise<Map<string, string>> {
  const groupIds = p.mentions.filter((m) => m.type === "group").map((m) => m.id);
  const members = groupIds.length ? (await tx.groupMember.findMany({ where: { groupId: { in: groupIds } }, select: { userId: true } })).map((m) => m.userId) : [];
  const mentioned = new Set([...p.mentions.filter((m) => m.type === "user").map((m) => m.id), ...members]);
  const followers = ACTIVITY.has(p.action) ? await subscribers(tx, [{ type: "thread", id: p.threadId }, { type: p.anchorType, id: p.anchorId }]) : [];
  const kinds = new Map<string, string>();
  for (const u of followers) kinds.set(u, "thread_activity");
  for (const u of mentioned) kinds.set(u, "mention"); // a mention wins over activity
  kinds.delete(p.actorId);
  return kinds;
}

/**
 * Users who may decide the request's current step: the step role in this workspace (directly or
 * through a group), filtered by eligible_approver() (role, step group, self-approval). Dimension
 * scope is checked when they open the request (the inbox filters by it).
 */
async function stepApprovers(tx: Tx, workspaceId: string, requestId: string): Promise<string[]> {
  const r = await tx.approvalRequest.findUnique({ where: { id: requestId } });
  const role = ((r?.policySnapshot ?? {}) as { chain?: Array<{ role?: string }> }).chain?.[r?.currentStep ?? 0]?.role;
  if (!r || !role) return [];
  const assignments = await tx.roleAssignment.findMany({ where: { workspaceId, role: role as "APPROVER" }, select: { principalType: true, principalId: true } });
  const direct = assignments.filter((a) => a.principalType === "user").map((a) => a.principalId);
  const groupIds = assignments.filter((a) => a.principalType === "group").map((a) => a.principalId);
  const viaGroups = groupIds.length ? (await tx.groupMember.findMany({ where: { groupId: { in: groupIds } }, select: { userId: true } })).map((m) => m.userId) : [];
  const out: string[] = [];
  for (const u of [...new Set([...direct, ...viaGroups])].sort()) if (await eligibleApproverSql(tx, r.id, u)) out.push(u);
  return out;
}

/**
 * notify-worker, in-app channel (spec §19). Once per outbox event, never to the actor:
 * - thread.changed: mentioned users and members of mentioned groups get `mention`; followers of the
 *   thread or its anchor get `thread_activity`.
 * - alert.triggered: the alert's owner gets `alert`.
 * - approval.changed: a new or escalated request notifies the current step's approvers
 *   (`approval_requested`); an outcome notifies the requester (`approval_outcome`).
 */
export async function handleInApp(prisma: PrismaClient, body: unknown): Promise<{ outcome: "applied" | "duplicate"; notified: string[] }> {
  const event: OutboxEvent = decodePush(body);
  const notified: string[] = [];
  const outcome = await handleOnce(prisma, IN_APP_CONSUMER, event, async (tx) => {
    const raw = (event.payload ?? {}) as Record<string, unknown>;
    let kinds = new Map<string, string>();
    let payload: Record<string, unknown> = { outboxId: event.outboxId };
    if (event.topic === "thread.changed") {
      const p = ThreadChanged.parse(raw);
      kinds = await threadRecipients(tx, p);
      payload = { threadId: p.threadId, commentId: p.commentId, action: p.action, actorId: p.actorId, anchorType: p.anchorType, anchorId: p.anchorId, outboxId: event.outboxId };
    } else if (event.topic === "alert.triggered") {
      const a = await tx.alert.findUnique({ where: { id: String(raw["alertId"]) }, select: { id: true, ownerId: true, envelopeId: true, severity: true, ruleId: true } });
      if (a?.ownerId) kinds.set(a.ownerId, "alert");
      payload = { alertId: a?.id, envelopeId: a?.envelopeId, ruleId: a?.ruleId, severity: a?.severity, reopened: raw["reopened"] === true, outboxId: event.outboxId };
    } else if (event.topic === "approval.changed") {
      const kind = approvalKind(raw);
      const requestId = String(raw["requestId"]);
      if (kind === "requested" || kind === "escalated") for (const u of await stepApprovers(tx, event.workspaceId, requestId)) kinds.set(u, "approval_requested");
      else if (kind) {
        const r = await tx.approvalRequest.findUnique({ where: { id: requestId }, select: { requestedBy: true } });
        if (r) kinds.set(r.requestedBy, "approval_outcome");
      }
      const actor = await tx.approvalDecision.findFirst({ where: { requestId }, orderBy: { decidedAt: "desc" }, select: { decidedBy: true } });
      if (kind && kind !== "requested" && actor) kinds.delete(actor.decidedBy);
      payload = { requestId, action: raw["action"], status: raw["status"] ?? null, kind: kind ?? null, outboxId: event.outboxId };
    }
    for (const [userId, kind] of [...kinds.entries()].sort()) {
      await insertNotification(tx, { workspaceId: event.workspaceId, userId, kind, payload });
      notified.push(userId);
    }
  });
  return { outcome, notified: outcome === "applied" ? notified : [] };
}

/** T-019's entry point; thread events go through the same handler. */
export const handleThreadChanged = handleInApp;
