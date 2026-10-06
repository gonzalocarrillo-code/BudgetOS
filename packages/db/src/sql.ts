import { Prisma } from "@prisma/client";
import type { AuditEventInput, OutboxInput } from "./facts.types.js";

export type Tx = Prisma.TransactionClient;

export async function audit(tx: Tx, event: AuditEventInput): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO audit_event (workspace_id, actor_id, actor_type, action, entity_type, entity_id, before, after, reason, request_id)
    VALUES (${event.workspaceId}::uuid, ${event.actorId}::uuid, ${event.actorType}, ${event.action}, ${event.entityType}, ${event.entityId}::uuid,
            ${JSON.stringify(event.before ?? null)}::jsonb, ${JSON.stringify(event.after ?? null)}::jsonb, ${event.reason ?? null}, ${event.requestId ?? null})`;
}

export async function outbox(tx: Tx, message: OutboxInput): Promise<void> {
  await tx.$executeRaw`INSERT INTO outbox (workspace_id, topic, payload) VALUES (${message.workspaceId}::uuid, ${message.topic}, ${JSON.stringify(message.payload)}::jsonb)`;
}

/**
 * The workspace's data version, which caches key on (`/query`, the tree, MCP results, exports).
 * W3-8 (ADR-0082): it is no longer bumped by write paths. A deferred trigger on `outbox` bumps
 * `workspace_data_version` at commit for every outbox row, so a write moves it by emitting its one
 * outbox row, in commit order, without holding a workspace-wide lock through the transaction.
 */
export async function readDataVersion(tx: Tx, workspaceId: string): Promise<number> {
  const rows = await tx.$queryRaw<{ v: bigint }[]>`SELECT version AS v FROM workspace_data_version WHERE workspace_id = ${workspaceId}::uuid`;
  return Number(rows[0]?.v ?? 0);
}
