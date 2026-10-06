import type { Tx } from "./sql.js";

/**
 * Slack post intents (audit I-21, ADR-015). The notify-worker's consumer transaction decides what to
 * post and records it here with `ts` still null; Slack is never called from inside that transaction,
 * so a later statement failing and rolling the transaction back can never leave a message sent with
 * no record of it. Posting happens afterwards, and `ts` is set in its own short transaction per post,
 * so one failed post in a batch never undoes the ones that already went out. `ON CONFLICT DO NOTHING`
 * on `(outbox_id, channel, dedupe_key)` makes recording idempotent for the same reason every outbox
 * write is: belt-and-suspenders alongside `processed_event`.
 */

export interface SlackMessageBody {
  text: string;
  blocks: unknown[];
}

export interface SlackDeliveryAbout {
  type: "alert" | "approval_request";
  id: string;
}

export interface SlackDeliveryIntent {
  id: string;
  workspaceId: string;
  outboxId: string;
  channel: string;
  /** Disambiguates posts within one outbox event when `about` alone would not (e.g. several direct messages about the same request, or a mention with no `about` at all). */
  dedupeKey: string;
  message: SlackMessageBody;
  about?: SlackDeliveryAbout;
}

/** Records a decision to post, before Slack is ever called (I-21). */
export async function recordSlackIntent(tx: Tx, intent: SlackDeliveryIntent): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO slack_delivery (id, workspace_id, outbox_id, channel, dedupe_key, message, about_type, about_id)
    VALUES (${intent.id}::uuid, ${intent.workspaceId}::uuid, ${intent.outboxId}::bigint, ${intent.channel}, ${intent.dedupeKey},
            ${JSON.stringify(intent.message)}::jsonb, ${intent.about?.type ?? null}, ${intent.about?.id ?? null}::uuid)
    ON CONFLICT (outbox_id, channel, dedupe_key) DO NOTHING`;
}

export interface PendingSlackDelivery {
  id: string;
  channel: string;
  message: SlackMessageBody;
  about: SlackDeliveryAbout | null;
}

/** Intents for one outbox event not yet posted: this run's own posts, or a previous run's that failed partway through. */
export async function pendingSlackDeliveries(tx: Tx, outboxId: string): Promise<PendingSlackDelivery[]> {
  // Ordered by id, not created_at: every intent for one outbox event is inserted in the same
  // transaction, where now() is constant, but the ids are UUID v7 (time-ordered), so this still
  // posts them in the order the handler decided them in.
  const rows = await tx.$queryRaw<Array<{ id: string; channel: string; message: SlackMessageBody; aboutType: "alert" | "approval_request" | null; aboutId: string | null }>>`
    SELECT id::text AS id, channel, message, about_type AS "aboutType", about_id::text AS "aboutId"
    FROM slack_delivery WHERE outbox_id = ${outboxId}::bigint AND ts IS NULL ORDER BY id`;
  return rows.map((r) => ({ id: r.id, channel: r.channel, message: r.message, about: r.aboutType && r.aboutId ? { type: r.aboutType, id: r.aboutId } : null }));
}

/** Marks one intent posted (idempotent: a no-op once `ts` is already set). */
export async function markSlackDeliveryPosted(tx: Tx, id: string, ts: string): Promise<void> {
  await tx.$executeRaw`UPDATE slack_delivery SET ts = ${ts}, posted_at = now() WHERE id = ${id}::uuid AND ts IS NULL`;
}

/** Records a message the bot posted (slack_message), so a later change to the same alert or request edits it instead of posting again. */
export async function recordSlackMessage(tx: Tx, workspaceId: string, about: SlackDeliveryAbout, ref: { channel: string; ts: string }): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO slack_message (workspace_id, entity_type, entity_id, channel, ts)
    VALUES (${workspaceId}::uuid, ${about.type}, ${about.id}::uuid, ${ref.channel}, ${ref.ts})
    ON CONFLICT DO NOTHING`;
}
