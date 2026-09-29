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
  /** Posts; returns the message's channel id and ts (to edit it later), when Slack says. */
  postMessage(m: { channel: string; text: string; blocks: SlackMessage["blocks"] }): Promise<{ channel: string; ts: string } | void>;
  /** Edits a message the bot posted (chat.update). */
  updateMessage?(m: { channel: string; ts: string; text: string; blocks: SlackMessage["blocks"] }): Promise<void>;
  /** Slack user id for an email, or null when the person is not in the Slack workspace. */
  lookupUserByEmail(email: string): Promise<string | null>;
}

/** `@slack/web-api` with a bot token (Secret Manager in deployed environments). */
export class WebApiSlack implements SlackClient {
  private readonly client: WebClient;
  constructor(token: string) {
    this.client = new WebClient(token);
  }
  async postMessage(m: { channel: string; text: string; blocks: SlackMessage["blocks"] }): Promise<{ channel: string; ts: string } | void> {
    const res = await this.client.chat.postMessage({ channel: m.channel, text: m.text, blocks: m.blocks as never, unfurl_links: false });
    if (res.channel && res.ts) return { channel: res.channel, ts: res.ts };
  }
  async updateMessage(m: { channel: string; ts: string; text: string; blocks: SlackMessage["blocks"] }): Promise<void> {
    await this.client.chat.update({ channel: m.channel, ts: m.ts, text: m.text, blocks: m.blocks as never });
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

/** What is missing for Slack messages to work, said once at start (a token without the web app's URL posts dead links). */
export function slackConfigWarnings(env: Record<string, string | undefined> = process.env): string[] {
  if (!env["SLACK_BOT_TOKEN"]) return [];
  return env["APP_BASE_URL"] ? [] : ["SLACK_BOT_TOKEN is set without APP_BASE_URL: links in Slack messages point at https://budget-os.example"];
}

export interface Outgoing {
  channel: string;
  message: SlackMessage;
  /** The alert or request the message is about: recorded, so later changes edit it. */
  about?: { type: "alert" | "approval_request"; id: string };
}
/** workspace.settings.slack (SlackSettings in @budget/domain). */
interface SlackSettings {
  defaultChannel?: string;
  alertChannel?: string;
  alertSeverities?: string[];
  approvals?: boolean;
  teamId?: string;
}
interface Settings {
  slack?: SlackSettings;
}

const names = async (tx: Tx, ids: string[]) => new Map((await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));

/**
 * Where an alert posts: the rule's channel; else the workspace's alert channel for the severities
 * it takes; else the default channel for critical alerts.
 */
export function alertChannel(delivery: { slackChannel?: string }, severity: string, s: SlackSettings): string | undefined {
  if (delivery.slackChannel) return delivery.slackChannel;
  const severities = s.alertSeverities ?? ["critical"];
  if (s.alertChannel && severities.includes(severity)) return s.alertChannel;
  return severity === "critical" ? s.defaultChannel : undefined;
}

async function alertMessageFor(tx: Tx, workspaceId: string, alertId: string, baseUrl: string, s: SlackSettings, reopened: boolean, statusBy: string | null) {
  const a = await tx.alert.findUnique({ where: { id: alertId } });
  if (a === null) return null;
  const rule = await tx.pacingRule.findUnique({ where: { id: a.ruleId } });
  const env = await tx.envelope.findUnique({ where: { id: a.envelopeId }, select: { name: true, currency: true } });
  const path = (await envelopePaths(tx, [a.envelopeId])).get(a.envelopeId) ?? [env?.name ?? ""];
  const ctx = (a.context ?? {}) as { budget?: string | null; actual?: string | null; evaluatedFor?: string };
  const owner = a.ownerId ? (await names(tx, [a.ownerId])).get(a.ownerId) ?? null : null;
  return {
    alert: a,
    delivery: (rule?.delivery ?? {}) as { slackChannel?: string },
    message: alertMessage({
        baseUrl,
        workspaceId,
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
        reopened,
        evaluatedFor: ctx.evaluatedFor ?? a.openedAt.toISOString().slice(0, 10),
        status: a.status,
        statusBy,
        snoozedUntil: a.snoozedUntil?.toISOString() ?? null,
        actions: Boolean(s.teamId),
      }),
  };
}

async function alertPosts(tx: Tx, event: OutboxEvent, p: Record<string, unknown>, baseUrl: string, s: SlackSettings): Promise<Outgoing[]> {
  const built = await alertMessageFor(tx, event.workspaceId, String(p["alertId"]), baseUrl, s, p["reopened"] === true, null);
  if (built === null) return [];
  const channel = alertChannel(built.delivery, built.alert.severity, s);
  if (!channel) return [];
  return [{ channel, message: built.message, about: { type: "alert", id: built.alert.id } }];
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

/** The approval post for this event; `editing` builds it for an existing message (no channel needed). */
async function approvalPosts(tx: Tx, event: OutboxEvent, p: Record<string, unknown>, baseUrl: string, s: SlackSettings, editing = false): Promise<Outgoing[]> {
  const kind = approvalKind(p);
  const channel = editing ? "" : s.defaultChannel;
  if (!kind || channel === undefined) return [];
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
        actions: Boolean(s.teamId) && s.approvals !== false,
      }),
      about: { type: "approval_request", id: r.id },
    },
  ];
}

/** Messages the bot posted about this alert or request (slack_message). */
const postedAbout = (tx: Tx, type: "alert" | "approval_request", id: string) => tx.$queryRaw<Array<{ channel: string; ts: string }>>`SELECT channel, ts FROM slack_message WHERE entity_type = ${type} AND entity_id = ${id}::uuid ORDER BY posted_at`;

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

/**
 * Push handler for `alert.triggered`, `alert.changed`, `approval.changed`, `thread.changed` and
 * `slack.test`. New alerts and requests are posted (and recorded); a change to one the bot already
 * posted edits that message instead — whether the change came from Slack or from the app. Without
 * a Slack client it acknowledges and posts nothing.
 */
export async function handleSlackEvent(prisma: PrismaClient, slack: SlackClient | null, body: unknown, baseUrl = process.env["APP_BASE_URL"] ?? "https://budget-os.example") {
  const event = decodePush(body);
  const posted: Outgoing[] = [];
  const edited: Array<{ channel: string; ts: string }> = [];
  const outcome = await handleOnce(prisma, SLACK_CONSUMER, event, async (tx) => {
    if (slack === null) return;
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const ws = await tx.workspace.findUniqueOrThrow({ where: { id: event.workspaceId }, select: { settings: true } });
    const s: SlackSettings = ((ws.settings ?? {}) as Settings).slack ?? {};

    // Changes to something already posted: edit those messages.
    if (event.topic === "alert.changed" || event.topic === "approval.changed") {
      const type = event.topic === "alert.changed" ? "alert" : "approval_request";
      const id = String(p[type === "alert" ? "alertId" : "requestId"] ?? "");
      const messages = id ? await postedAbout(tx, type, id) : [];
      if (messages.length && slack.updateMessage) {
        let message: SlackMessage | null = null;
        if (type === "alert") {
          const actor = event.topic === "alert.changed" ? await lastActor(tx, "alert", id) : null;
          message = (await alertMessageFor(tx, event.workspaceId, id, baseUrl, s, false, actor))?.message ?? null;
        } else if (approvalKind(p)) {
          message = (await approvalPosts(tx, event, p, baseUrl, s, true))[0]?.message ?? null;
        }
        if (message) {
          for (const m of messages) {
            await slack.updateMessage({ channel: m.channel, ts: m.ts, text: message.text, blocks: message.blocks });
            edited.push(m);
          }
        }
        return;
      }
      if (event.topic === "alert.changed") return; // never posted: nothing to edit
    }

    const outgoing =
      event.topic === "alert.triggered"
        ? await alertPosts(tx, event, p, baseUrl, s)
        : event.topic === "approval.changed"
          ? await approvalPosts(tx, event, p, baseUrl, s)
          : event.topic === "thread.changed"
            ? await mentionPosts(tx, event, p, baseUrl, slack)
            : event.topic === "slack.test" && typeof p["channel"] === "string"
              ? [{ channel: p["channel"], message: testMessage(baseUrl, event.workspaceId, typeof p["requestedBy"] === "string" ? p["requestedBy"] : null) }]
              : [];
    for (const o of outgoing) {
      const ref = await slack.postMessage({ channel: o.channel, text: o.message.text, blocks: o.message.blocks });
      if (ref && o.about) {
        await tx.$executeRaw`INSERT INTO slack_message (workspace_id, entity_type, entity_id, channel, ts) VALUES (${event.workspaceId}::uuid, ${o.about.type}, ${o.about.id}::uuid, ${ref.channel}, ${ref.ts}) ON CONFLICT DO NOTHING`;
      }
      posted.push(o);
    }
  });
  if (slack === null) log.info({ outboxId: event.outboxId, topic: event.topic }, "no SLACK_BOT_TOKEN: Slack delivery skipped");
  return { outcome, posted, edited };
}

/** Who made the latest audited change to an entity (shown as "Acknowledged by …"). */
async function lastActor(tx: Tx, entityType: string, id: string): Promise<string | null> {
  const [row] = await tx.$queryRaw<Array<{ name: string | null }>>`SELECT u.name FROM audit_event a LEFT JOIN app_user u ON u.id = a.actor_id WHERE a.entity_type = ${entityType} AND a.entity_id = ${id}::uuid ORDER BY a.occurred_at DESC LIMIT 1`;
  return row?.name ?? null;
}

function testMessage(baseUrl: string, workspaceId: string, by: string | null): SlackMessage {
  return {
    text: ":white_check_mark: Budget OS is connected",
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `:white_check_mark: *Budget OS is connected.*${by ? ` Test sent by ${by}.` : ""} Alerts and approvals for this workspace post here.` } },
      { type: "context", elements: [{ type: "mrkdwn", text: `<${baseUrl.replace(/\/$/, "")}/w/${workspaceId}/admin/slack|Slack settings>` }] },
    ],
  };
}
