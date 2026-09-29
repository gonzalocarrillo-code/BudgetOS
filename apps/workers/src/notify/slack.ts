import { envelopePaths, lastActorId, loadBulkChange, type Tx } from "@budget/db";
import { WebClient } from "@slack/web-api";
import type { PrismaClient } from "@prisma/client";
import { decodePush, handleOnce, type OutboxEvent } from "../consumer.js";
import { log } from "../log.js";
import { alertMessage } from "./blocks/alert.js";
import { approvalMessage, approvalReminder } from "./blocks/approval.js";
import type { SlackMessage } from "./blocks/common.js";
import { mentionMessage } from "./blocks/mention.js";
import { approvalKind, stepApprovers, type ApprovalKind } from "./approvals.js";

/**
 * notify-worker, Slack channel (spec §19): `chat.postMessage` with Block Kit for alerts (the rule's
 * channel, or the workspace default for critical alerts), approval requests and outcomes (the
 * workspace default channel, and direct messages to the step's approvers and the requester, S-004)
 * and mentions (a direct message, found by email). Deduplicated per
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
  /** The bot's direct-message channel with a Slack user (conversations.open), so a message already sent there is recognised. */
  openDm?(slackUserId: string): Promise<string>;
}

/** Slack user ids and direct-message channels change rarely: remembered for an hour per worker instance. */
const LOOKUP_TTL_MS = 60 * 60_000;

/** `@slack/web-api` with a bot token (Secret Manager in deployed environments). */
export class WebApiSlack implements SlackClient {
  private readonly client: WebClient;
  private readonly users = new Map<string, { id: string | null; at: number }>();
  private readonly dms = new Map<string, { id: string; at: number }>();
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
    const hit = this.users.get(email);
    if (hit && Date.now() - hit.at < LOOKUP_TTL_MS) return hit.id;
    let id: string | null;
    try {
      id = (await this.client.users.lookupByEmail({ email })).user?.id ?? null;
    } catch (error) {
      if ((error as { data?: { error?: string } }).data?.error !== "users_not_found") throw error;
      id = null;
    }
    this.users.set(email, { id, at: Date.now() });
    return id;
  }
  async openDm(slackUserId: string): Promise<string> {
    const hit = this.dms.get(slackUserId);
    if (hit && Date.now() - hit.at < LOOKUP_TTL_MS) return hit.id;
    const id = (await this.client.conversations.open({ users: slackUserId })).channel?.id ?? slackUserId;
    this.dms.set(slackUserId, { id, at: Date.now() });
    return id;
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
  defaultChannel?: string | undefined;
  alertChannel?: string | undefined;
  alertSeverities?: string[] | undefined;
  approvals?: boolean | undefined;
  dms?: boolean | undefined;
  teamId?: string | undefined;
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

/** An approval event's message, for the request as it is now. `extra` makes a private card (S-007): its buttons' origin, and whether to show them. */
async function approvalMessageFor(tx: Tx, workspaceId: string, requestId: string, kind: ApprovalKind, comment: string | null, baseUrl: string, s: SlackSettings, extra: { origin?: "card"; actions?: boolean } = {}): Promise<SlackMessage | null> {
  const r = await tx.approvalRequest.findUnique({ where: { id: requestId }, include: { decisions: { orderBy: { decidedAt: "desc" }, take: 1 } } });
  if (r === null) return null;
  const snapshot = (r.policySnapshot ?? {}) as { policyName?: string; chain?: Array<{ role?: string }> };
  let subject = "Change";
  let before: string | null = null;
  let after: string | null = null;
  let currency = "";
  let path: string | null = null;
  let period: { start: string; end: string } | null = null;
  let rationale: string | null = null;
  if (r.entityType === "envelope_version") {
    const v = await tx.envelopeVersion.findUnique({ where: { id: r.entityId }, include: { envelope: { select: { name: true, displayName: true, currency: true, startDate: true, endDate: true } } } });
    const base = v?.basedOnVersionId ? await tx.envelopeVersion.findUnique({ where: { id: v.basedOnVersionId }, select: { amount: true } }) : null;
    subject = v?.envelope.displayName ?? v?.envelope.name ?? subject;
    currency = v?.envelope.currency ?? "";
    after = v ? v.amount.toFixed(2) : null;
    before = base ? base.amount.toFixed(2) : null;
    path = v ? ((await envelopePaths(tx, [v.envelopeId])).get(v.envelopeId)?.join(" › ") ?? null) : null;
    period = v ? { start: v.envelope.startDate.toISOString().slice(0, 10), end: v.envelope.endDate.toISOString().slice(0, 10) } : null;
    rationale = v?.rationale ?? null;
  } else if (r.entityType === "target_version") {
    const tv = await tx.targetVersion.findUnique({ where: { id: r.entityId }, include: { target: true } });
    const env = tv?.target.envelopeId ? await tx.envelope.findUnique({ where: { id: tv.target.envelopeId }, select: { name: true } }) : null;
    subject = `${(tv?.target.metricKey ?? "kpi").toUpperCase()} target · ${env?.name ?? "filter scope"}`;
  } else if (r.entityType === "bulk_change") {
    const bulk = await loadBulkChange(tx, r.entityId);
    const n = bulk?.versionIds.length ?? 0;
    subject = `${BULK_LABEL[bulk?.kind ?? "edit"] ?? "Bulk change"} (${n} ${n === 1 ? "budget" : "budgets"})`;
  }
  const decider = r.decisions[0]?.decidedBy;
  const people = await names(tx, [r.requestedBy, ...(decider ? [decider] : [])]);
  return approvalMessage({
    baseUrl,
    workspaceId,
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
    comment,
    actions: extra.actions ?? (Boolean(s.teamId) && s.approvals !== false),
    ...(extra.origin ? { origin: extra.origin } : {}),
    path,
    period,
    rationale,
    step: { index: r.currentStep, count: snapshot.chain?.length ?? 1 },
  });
}

/** What a bulk change's request is called in Slack, by the kind of change (bulk_change.kind). */
const BULK_LABEL: Record<string, string> = { edit: "Bulk change", split: "Split", merge: "Merge", end: "End a budget", reintroduce: "Reintroduce a budget", import: "Budget import", dates: "Change dates" };

const KIND_OF_STATUS: Record<string, ApprovalKind> = { PENDING: "requested", ESCALATED: "escalated", APPROVED: "approved", REJECTED: "rejected", CHANGES_REQUESTED: "changes_requested", WITHDRAWN: "withdrawn" };

/**
 * A request as a private card (S-007, `/budget show #id`), read in the caller's transaction so row
 * security applies: where it is now, with the last decision's comment, and the Approve / Request
 * changes / Reject buttons when `actions` (the caller may decide it).
 */
export async function approvalCard(tx: Tx, workspaceId: string, requestId: string, baseUrl: string, settings: SlackSettings, opts: { actions: boolean }): Promise<SlackMessage | null> {
  const r = await tx.approvalRequest.findUnique({ where: { id: requestId }, select: { status: true, decisions: { orderBy: { decidedAt: "desc" }, take: 1, select: { comment: true } } } });
  if (r === null) return null;
  const open = OPEN.includes(r.status);
  return approvalMessageFor(tx, workspaceId, requestId, KIND_OF_STATUS[r.status] ?? "requested", open ? null : (r.decisions[0]?.comment ?? null), baseUrl, settings, { origin: "card", actions: opts.actions && open && settings.approvals !== false });
}

const OPEN = ["PENDING", "ESCALATED"];
/** At most this many direct messages per event; a larger step is a group's job. */
const MAX_DMS = 25;

/** The bot's direct-message channel with a Budget OS user, or null when they are not in Slack (or inactive). */
async function dmChannel(tx: Tx, slack: SlackClient, userId: string): Promise<string | null> {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { email: true, isActive: true } });
  if (!user?.isActive) return null;
  const slackUser = await slack.lookupUserByEmail(user.email);
  if (!slackUser) return null;
  return slack.openDm ? slack.openDm(slackUser) : slackUser;
}

/**
 * What an approval event (approval.changed, approval.reminded) does in Slack (S-004):
 * - every message already posted about the request is edited to where the request is now;
 * - the default channel gets the request once (an outcome posts there only if the request never did);
 * - while it waits, each approver of the current step gets a direct message, once per request (a
 *   reminder sends a new one); on the outcome, the requester does, unless they acted themselves.
 * Direct messages are off when the workspace turns them off (settings.slack.dms).
 */
async function approvalDelivery(tx: Tx, event: OutboxEvent, p: Record<string, unknown>, baseUrl: string, s: SlackSettings, slack: SlackClient): Promise<{ message: SlackMessage | null; edits: Array<{ channel: string; ts: string }>; posts: Outgoing[] }> {
  const none = { message: null, edits: [], posts: [] };
  const requestId = typeof p["requestId"] === "string" ? p["requestId"] : "";
  const r = requestId ? await tx.approvalRequest.findUnique({ where: { id: requestId }, select: { id: true, currentStep: true, status: true, requestedBy: true } }) : null;
  if (r === null) return none;
  const reminder = event.topic === "approval.reminded";
  if (reminder && !OPEN.includes(r.status)) return none; // decided since the reminder was sent
  const kind = reminder ? "requested" : approvalKind(p, r);
  if (!kind) return none;
  const message = await approvalMessageFor(tx, event.workspaceId, r.id, kind, typeof p["comment"] === "string" ? p["comment"] : null, baseUrl, s);
  if (message === null) return none;
  const about = { type: "approval_request" as const, id: r.id };
  const recorded = await postedAbout(tx, "approval_request", r.id);
  const posts: Outgoing[] = [];
  // Nothing changed with a reminder: the messages already say where the request is.
  const edits = reminder || !slack.updateMessage ? [] : recorded;
  const inChannel = recorded.some((m) => !m.channel.startsWith("D"));
  if (!reminder && !inChannel && s.defaultChannel) posts.push({ channel: s.defaultChannel, message, about });
  if (s.dms === false) return { message, edits, posts };
  if (kind === "requested" || kind === "escalated") {
    const by = reminder && typeof p["by"] === "string" ? ((await names(tx, [p["by"]])).get(p["by"]) ?? null) : null;
    const dm = reminder ? approvalReminder(message, by) : message;
    for (const userId of (await stepApprovers(tx, event.workspaceId, r.id)).slice(0, MAX_DMS)) {
      const channel = await dmChannel(tx, slack, userId);
      if (channel === null) continue;
      if (!reminder && recorded.some((m) => m.channel === channel)) continue; // told already; the edit shows the new step
      posts.push({ channel, message: dm, about });
    }
  } else if ((await lastActorId(tx, "approval_request", r.id)) !== r.requestedBy) {
    const channel = await dmChannel(tx, slack, r.requestedBy);
    if (channel !== null) posts.push({ channel, message, about });
  }
  return { message, edits, posts };
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
 * Push handler for `alert.triggered`, `alert.changed`, `approval.changed`, `approval.reminded`,
 * `thread.changed` and `slack.test`. New alerts and requests are posted (and recorded); a change to
 * one the bot already posted edits that message instead — whether the change came from Slack or
 * from the app. Without a Slack client it acknowledges and posts nothing.
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
    const post = async (o: Outgoing) => {
      const ref = await slack.postMessage({ channel: o.channel, text: o.message.text, blocks: o.message.blocks });
      if (ref && o.about) {
        await tx.$executeRaw`INSERT INTO slack_message (workspace_id, entity_type, entity_id, channel, ts) VALUES (${event.workspaceId}::uuid, ${o.about.type}, ${o.about.id}::uuid, ${ref.channel}, ${ref.ts}) ON CONFLICT DO NOTHING`;
      }
      posted.push(o);
    };
    const edit = async (m: { channel: string; ts: string }, message: SlackMessage) => {
      await slack.updateMessage?.({ channel: m.channel, ts: m.ts, text: message.text, blocks: message.blocks });
      edited.push(m);
    };

    if (event.topic === "approval.changed" || event.topic === "approval.reminded") {
      const plan = await approvalDelivery(tx, event, p, baseUrl, s, slack);
      if (plan.message) for (const m of plan.edits) await edit(m, plan.message);
      for (const o of plan.posts) await post(o);
      return;
    }

    // A change to an alert already posted: edit those messages (never posted: nothing to edit).
    if (event.topic === "alert.changed") {
      const id = String(p["alertId"] ?? "");
      const messages = id ? await postedAbout(tx, "alert", id) : [];
      if (messages.length && slack.updateMessage) {
        const actor = await lastActor(tx, "alert", id);
        const message = (await alertMessageFor(tx, event.workspaceId, id, baseUrl, s, false, actor))?.message ?? null;
        if (message) for (const m of messages) await edit(m, message);
      }
      return;
    }

    const outgoing =
      event.topic === "alert.triggered"
        ? await alertPosts(tx, event, p, baseUrl, s)
        : event.topic === "thread.changed"
          ? await mentionPosts(tx, event, p, baseUrl, slack)
          : event.topic === "slack.test" && typeof p["channel"] === "string"
            ? [{ channel: p["channel"], message: testMessage(baseUrl, event.workspaceId, typeof p["requestedBy"] === "string" ? p["requestedBy"] : null) }]
            : [];
    for (const o of outgoing) await post(o);
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
    text: ":white_check_mark: BudgetOS is connected",
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `:white_check_mark: *BudgetOS is connected.*${by ? ` Test sent by ${by}.` : ""} Alerts and approvals for this workspace post here.` } },
      { type: "context", elements: [{ type: "mrkdwn", text: `<${baseUrl.replace(/\/$/, "")}/w/${workspaceId}/admin/slack|Slack settings>` }] },
    ],
  };
}
