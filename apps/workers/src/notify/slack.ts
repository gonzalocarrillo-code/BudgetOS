import { envelopePaths, loadBulkChange, type Tx } from "@budget/db";
import { WebClient } from "@slack/web-api";
import type { PrismaClient } from "@prisma/client";
import { decodePush, handleOnce, type OutboxEvent } from "../consumer.js";
import { log } from "../log.js";
import { alertMessage } from "./blocks/alert.js";
import { approvalMessage, type ApprovalMessageInput } from "./blocks/approval.js";
import type { SlackMessage } from "./blocks/common.js";
import { mentionMessage } from "./blocks/mention.js";

/**
 * notify-worker, Slack channel (spec §19): `chat.postMessage` with Block Kit for alerts (the rule's
 * channel, or the workspace default for critical alerts), approval requests and outcomes (the
 * workspace default channel) and mentions (a direct message, found by email). Deduplicated per
 * outbox id under its own consumer, so a Slack failure retries only Slack. A post that succeeds
 * while the dedupe commit fails is sent again on redelivery (at least once, ADR-015).
 */

export const SLACK_CONSUMER = "notify-slack";

export interface SlackClient {
  postMessage(m: { channel: string; text: string; blocks: SlackMessage["blocks"] }): Promise<void>;
  /** Slack user id for an email, or null when the person is not in the Slack workspace. */
  lookupUserByEmail(email: string): Promise<string | null>;
}

/** `@slack/web-api` with a bot token (Secret Manager in deployed environments). */
export class WebApiSlack implements SlackClient {
  private readonly client: WebClient;
  constructor(token: string) {
    this.client = new WebClient(token);
  }
  async postMessage(m: { channel: string; text: string; blocks: SlackMessage["blocks"] }): Promise<void> {
    await this.client.chat.postMessage({ channel: m.channel, text: m.text, blocks: m.blocks as never, unfurl_links: false });
  }
  async lookupUserByEmail(email: string): Promise<string | null> {
    try {
      const res = await this.client.users.lookupByEmail({ email });
      return res.user?.id ?? null;
    } catch (error) {
      if ((error as { data?: { error?: string } }).data?.error === "users_not_found") return null;
      throw error;
    }
  }
}

export function slackFromEnv(env: NodeJS.ProcessEnv = process.env): SlackClient | null {
  const token = env["SLACK_BOT_TOKEN"];
  return token ? new WebApiSlack(token) : null;
}

export interface Outgoing {
  channel: string;
  message: SlackMessage;
}
interface Settings {
  slack?: { defaultChannel?: string };
}

const names = async (tx: Tx, ids: string[]) => new Map((await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));

async function alertPosts(tx: Tx, event: OutboxEvent, p: Record<string, unknown>, baseUrl: string, defaultChannel: string | undefined): Promise<Outgoing[]> {
  const a = await tx.alert.findUnique({ where: { id: String(p["alertId"]) } });
  if (a === null) return [];
  const rule = await tx.pacingRule.findUnique({ where: { id: a.ruleId } });
  const delivery = (rule?.delivery ?? {}) as { slackChannel?: string };
  const channel = delivery.slackChannel ?? (a.severity === "critical" ? defaultChannel : undefined);
  if (!channel) return [];
  const env = await tx.envelope.findUnique({ where: { id: a.envelopeId }, select: { name: true, currency: true } });
  const path = (await envelopePaths(tx, [a.envelopeId])).get(a.envelopeId) ?? [env?.name ?? ""];
  const ctx = (a.context ?? {}) as { budget?: string | null; actual?: string | null; evaluatedFor?: string };
  const owner = a.ownerId ? (await names(tx, [a.ownerId])).get(a.ownerId) ?? null : null;
  return [
    {
      channel,
      message: alertMessage({
        baseUrl,
        workspaceId: event.workspaceId,
        alertId: a.id,
        envelopeId: a.envelopeId,
        ruleName: rule?.name ?? "Pacing alert",
        severity: a.severity as "warning",
        metric: rule?.metric ?? "metric",
        metricValue: a.metricValue.toString(),
        comparator: rule?.comparator ?? "gt",
        threshold: a.threshold.toString(),
        envelopePath: path.join(" › "),
        budget: ctx.budget ?? null,
        actual: ctx.actual ?? null,
        currency: env?.currency ?? "",
        ownerName: owner,
        reopened: p["reopened"] === true,
        evaluatedFor: ctx.evaluatedFor ?? a.openedAt.toISOString().slice(0, 10),
      }),
    },
  ];
}

const APPROVAL_KIND: Record<string, ApprovalMessageInput["kind"] | undefined> = {
  "approval.requested": "requested",
  "approval.escalated": "escalated",
  "approval.withdrawn": "withdrawn",
};
const OUTCOME: Record<string, ApprovalMessageInput["kind"] | undefined> = { APPROVED: "approved", REJECTED: "rejected", CHANGES_REQUESTED: "changes_requested" };

/** The approval kinds worth a channel post: new requests, escalations and final outcomes (not every intermediate step). */
export function approvalKind(p: Record<string, unknown>): ApprovalMessageInput["kind"] | undefined {
  const action = String(p["action"] ?? "");
  return APPROVAL_KIND[action] ?? (action.startsWith("approval.") && typeof p["status"] === "string" ? OUTCOME[p["status"]] : undefined);
}

async function approvalPosts(tx: Tx, event: OutboxEvent, p: Record<string, unknown>, baseUrl: string, channel: string | undefined): Promise<Outgoing[]> {
  const kind = approvalKind(p);
  if (!kind || !channel) return [];
  const r = await tx.approvalRequest.findUnique({ where: { id: String(p["requestId"]) }, include: { decisions: { orderBy: { decidedAt: "desc" }, take: 1 } } });
  if (r === null) return [];
  const snapshot = (r.policySnapshot ?? {}) as { policyName?: string; chain?: Array<{ role?: string }> };
  let subject = "Change";
  let before: string | null = null;
  let after: string | null = null;
  let currency = "";
  if (r.entityType === "envelope_version") {
    const v = await tx.envelopeVersion.findUnique({ where: { id: r.entityId }, include: { envelope: { select: { name: true, currency: true } } } });
    const base = v?.basedOnVersionId ? await tx.envelopeVersion.findUnique({ where: { id: v.basedOnVersionId }, select: { amount: true } }) : null;
    subject = v?.envelope.name ?? subject;
    currency = v?.envelope.currency ?? "";
    after = v ? v.amount.toFixed(2) : null;
    before = base ? base.amount.toFixed(2) : null;
  } else if (r.entityType === "target_version") {
    const tv = await tx.targetVersion.findUnique({ where: { id: r.entityId }, include: { target: true } });
    const env = tv?.target.envelopeId ? await tx.envelope.findUnique({ where: { id: tv.target.envelopeId }, select: { name: true } }) : null;
    subject = `${(tv?.target.metricKey ?? "kpi").toUpperCase()} target · ${env?.name ?? "filter scope"}`;
  } else if (r.entityType === "bulk_change") {
    const bulk = await loadBulkChange(tx, r.entityId);
    subject = `Bulk change (${bulk?.versionIds.length ?? 0} rows)`;
  }
  const decider = r.decisions[0]?.decidedBy;
  const people = await names(tx, [r.requestedBy, ...(decider ? [decider] : [])]);
  return [
    {
      channel,
      message: approvalMessage({
        baseUrl,
        workspaceId: event.workspaceId,
        requestId: r.id,
        kind,
        subject,
        summary: r.summary,
        requesterName: people.get(r.requestedBy) ?? "Someone",
        deciderName: kind === "requested" || kind === "escalated" ? null : decider ? (people.get(decider) ?? null) : null,
        before,
        after,
        currency,
        stepRole: snapshot.chain?.[r.currentStep]?.role ?? null,
        policyName: snapshot.policyName ?? "Policy",
        dueAt: r.dueAt?.toISOString() ?? null,
        comment: typeof p["comment"] === "string" ? p["comment"] : null,
      }),
    },
  ];
}

async function mentionPosts(tx: Tx, event: OutboxEvent, p: Record<string, unknown>, baseUrl: string, slack: SlackClient): Promise<Outgoing[]> {
  const mentions = (Array.isArray(p["mentions"]) ? p["mentions"] : []) as Array<{ type: string; id: string }>;
  if (mentions.length === 0 || typeof p["commentId"] !== "string") return [];
  const c = await tx.comment.findUnique({ where: { id: p["commentId"] }, include: { thread: true } });
  if (c === null || c.deletedAt) return [];
  const groupIds = mentions.filter((m) => m.type === "group").map((m) => m.id);
  const members = groupIds.length ? (await tx.groupMember.findMany({ where: { groupId: { in: groupIds } }, select: { userId: true } })).map((m) => m.userId) : [];
  const recipients = [...new Set([...mentions.filter((m) => m.type === "user").map((m) => m.id), ...members])].filter((u) => u !== c.authorId);
  const users = await tx.user.findMany({ where: { id: { in: [...recipients, c.authorId, ...mentions.map((m) => m.id)] } }, select: { id: true, name: true, email: true } });
  const groups = await tx.group.findMany({ where: { id: { in: groupIds } }, select: { id: true, name: true } });
  const display = Object.fromEntries([...users.map((u) => [u.id, u.name]), ...groups.map((g) => [g.id, g.name])]);
  const envelopeId = c.thread.anchorType === "envelope" || c.thread.anchorType === "cell" ? c.thread.anchorId : null;
  const anchorLabel = envelopeId ? ((await envelopePaths(tx, [envelopeId])).get(envelopeId) ?? []).join(" › ") : c.thread.anchorType.replace(/_/g, " ");
  const out: Outgoing[] = [];
  for (const userId of recipients.sort()) {
    const email = users.find((u) => u.id === userId)?.email;
    const slackUser = email ? await slack.lookupUserByEmail(email) : null;
    if (!slackUser) continue; // not in the Slack workspace: in-app only
    out.push({
      channel: slackUser,
      message: mentionMessage({ baseUrl, workspaceId: event.workspaceId, commentId: c.id, authorName: display[c.authorId] ?? "Someone", anchorLabel, threadTitle: c.thread.title, bodyMd: c.bodyMd, names: display }),
    });
  }
  return out;
}

/** Push handler for `alert.triggered`, `approval.changed` and `thread.changed`. Without a Slack client it acknowledges and posts nothing. */
export async function handleSlackEvent(prisma: PrismaClient, slack: SlackClient | null, body: unknown, baseUrl = process.env["APP_BASE_URL"] ?? "https://budget-os.example") {
  const event = decodePush(body);
  const posted: Outgoing[] = [];
  const outcome = await handleOnce(prisma, SLACK_CONSUMER, event, async (tx) => {
    if (slack === null) return;
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const ws = await tx.workspace.findUniqueOrThrow({ where: { id: event.workspaceId }, select: { settings: true } });
    const defaultChannel = ((ws.settings ?? {}) as Settings).slack?.defaultChannel;
    const outgoing =
      event.topic === "alert.triggered"
        ? await alertPosts(tx, event, p, baseUrl, defaultChannel)
        : event.topic === "approval.changed"
          ? await approvalPosts(tx, event, p, baseUrl, defaultChannel)
          : event.topic === "thread.changed"
            ? await mentionPosts(tx, event, p, baseUrl, slack)
            : [];
    for (const o of outgoing) {
      await slack.postMessage({ channel: o.channel, text: o.message.text, blocks: o.message.blocks });
      posted.push(o);
    }
  });
  if (slack === null) log.info({ outboxId: event.outboxId, topic: event.topic }, "no SLACK_BOT_TOKEN: Slack delivery skipped");
  return { outcome, posted };
}
