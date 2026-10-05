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
 *
 * `timeoutMs` overrides withTenant()'s 15s default (I-7): a whole-workspace rebuild (roll-up on
 * registry.changed, search re-index on naming.changed kind=display) can outrun that, abort the
 * transaction, and — without this — leave the event looking failed when most of it committed
 * nothing. Callers that rebuild pass a longer budget; everything else keeps the default.
 */
export async function handleOnce(prisma: PrismaClient, consumer: string, event: OutboxEvent, handler: EventHandler, opts: { timeoutMs?: number } = {}): Promise<"applied" | "duplicate" | "skipped"> {
  const ctx: TenantContext = { workspaceId: event.workspaceId, orgId: event.orgId, userId: null, isOrgAdmin: false, actorType: "system", requestId: `${consumer}-${event.outboxId}` };
  const outcome = await withTenant(
    prisma,
    ctx,
    async (tx) => {
      if (!(await markProcessed(tx, consumer, event.outboxId))) return "duplicate" as const;
      // ADR-052: an archived or deleted workspace is frozen; its events are acknowledged, not applied.
      const [ws] = await tx.$queryRaw<Array<{ status: string; deleted: boolean }>>`SELECT status, deleted_at IS NOT NULL AS deleted FROM workspace WHERE id = ${event.workspaceId}::uuid`;
      if (ws && (ws.status !== "ACTIVE" || ws.deleted)) return "skipped" as const;
      await handler(tx, event);
      return "applied" as const;
    },
    opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs },
  );
  log.info({ consumer, outboxId: event.outboxId, topic: event.topic, workspaceId: event.workspaceId, requestId: ctx.requestId, outcome }, "outbox event");
  return outcome;
}
