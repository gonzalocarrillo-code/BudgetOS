import type { Tx } from "./sql.js";

/** An outbox row as the publisher reads it. `id` is bigserial, carried as a decimal string. */
export interface OutboxRow {
  id: string;
  workspaceId: string | null;
  orgId: string | null;
  topic: string;
  payload: unknown;
  createdAt: Date;
}

/**
 * Locks up to `limit` unpublished rows in id order (spec §19). SKIP LOCKED lets several publishers
 * run side by side without taking the same row. Runs as budget_publisher (ADR-010).
 */
export async function claimOutbox(tx: Tx, limit: number): Promise<OutboxRow[]> {
  return tx.$queryRaw<OutboxRow[]>`
    SELECT o.id::text AS id, o.workspace_id::text AS "workspaceId", w.org_id::text AS "orgId", o.topic, o.payload, o.created_at AS "createdAt"
    FROM outbox o LEFT JOIN workspace w ON w.id = o.workspace_id
    WHERE o.published_at IS NULL ORDER BY o.id LIMIT ${limit} FOR UPDATE OF o SKIP LOCKED`;
}

export async function markOutboxPublished(tx: Tx, ids: string[]): Promise<number> {
  return tx.$executeRaw`UPDATE outbox SET published_at = now() WHERE id = ANY(${ids}::bigint[]) AND published_at IS NULL`;
}

/**
 * Records that `consumer` handled outbox row `outboxId`; false when it already had (spec §19
 * processed_event). Call inside withTenant() for the event's workspace: the RLS policy only admits
 * a row whose outbox event that tenant can see, so a message with a forged workspace fails here.
 */
export async function markProcessed(tx: Tx, consumer: string, outboxId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ ok: number }>>`
    INSERT INTO processed_event (consumer, outbox_id) VALUES (${consumer}, ${outboxId}::bigint)
    ON CONFLICT (consumer, outbox_id) DO NOTHING RETURNING 1 AS ok`;
  return rows.length === 1;
}
