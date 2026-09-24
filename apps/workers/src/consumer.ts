import { DomainError, PubSubPush, type OutboxEventAttributes } from "@budget/domain";
import { markProcessed, withTenant, type TenantContext, type Tx } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { log } from "./log.js";

/** A decoded outbox event: the attributes the publisher set plus the outbox payload. */
export interface OutboxEvent extends OutboxEventAttributes {
  payload: unknown;
}

export type EventHandler = (tx: Tx, event: OutboxEvent) => Promise<void>;

/** Validates a Pub/Sub push body (the boundary) and decodes the outbox payload from `data`. */
export function decodePush(raw: unknown): OutboxEvent {
  const parsed = PubSubPush.safeParse(raw);
  if (!parsed.success) throw new DomainError("VALIDATION", "Invalid Pub/Sub push body", { issues: parsed.error.flatten() });
  const { attributes, data } = parsed.data.message;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
  } catch {
    throw new DomainError("VALIDATION", "Message data is not base64 JSON", { outboxId: attributes.outboxId });
  }
  return { ...attributes, payload };
}

/**
 * Runs `handler` for an event at most once per consumer (spec §19). The processed_event row and
 * the handler's writes share one transaction in the event's workspace: a duplicate delivery finds
 * the row and does nothing; a handler that throws rolls the row back, so the redelivery runs it.
 * Returns "duplicate" for a delivery that was already applied.
 */
export async function handleOnce(prisma: PrismaClient, consumer: string, event: OutboxEvent, handler: EventHandler): Promise<"applied" | "duplicate"> {
  const ctx: TenantContext = { workspaceId: event.workspaceId, orgId: event.orgId, userId: null, isOrgAdmin: false, actorType: "system", requestId: `${consumer}-${event.outboxId}` };
  const outcome = await withTenant(prisma, ctx, async (tx) => {
    if (!(await markProcessed(tx, consumer, event.outboxId))) return "duplicate" as const;
    await handler(tx, event);
    return "applied" as const;
  });
  log.info({ consumer, outboxId: event.outboxId, topic: event.topic, workspaceId: event.workspaceId, requestId: ctx.requestId, outcome }, "outbox event");
  return outcome;
}
