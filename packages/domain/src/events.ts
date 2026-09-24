import { z } from "zod";

/**
 * Outbox events on the wire (spec §19). The publisher sends the outbox payload as the message data
 * and the outbox id, workspace, org and topic as attributes; subscribers dedupe on the outbox id.
 */
export const OutboxId = z.string().regex(/^[1-9]\d{0,18}$/, "outbox id is a positive bigint");

export const OutboxEventAttributes = z.object({
  outboxId: OutboxId,
  workspaceId: z.string().uuid(),
  orgId: z.string().uuid(),
  topic: z.string().min(1).max(100),
});
export type OutboxEventAttributes = z.infer<typeof OutboxEventAttributes>;

/** Body of a Pub/Sub push request to a Cloud Run subscriber. */
export const PubSubPush = z.object({
  message: z.object({
    data: z.string().base64(),
    attributes: OutboxEventAttributes,
    messageId: z.string().min(1),
    publishTime: z.string().datetime().optional(),
  }),
  subscription: z.string().min(1),
  deliveryAttempt: z.number().int().optional(),
});
export type PubSubPush = z.infer<typeof PubSubPush>;
