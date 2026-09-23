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

/** Bump the workspace data_version (used by caches). Stored in workspace.settings->>'dataVersion'. */
export async function bumpDataVersion(tx: Tx, workspaceId: string): Promise<number> {
  const rows = await tx.$queryRaw<{ v: number }[]>`
    UPDATE workspace SET settings = jsonb_set(settings, '{dataVersion}', to_jsonb(coalesce((settings->>'dataVersion')::bigint,0)+1))
    WHERE id = ${workspaceId}::uuid RETURNING (settings->>'dataVersion')::int AS v`;
  const version = rows[0];
  if (version === undefined) {
    throw new Error(`workspace ${workspaceId} not found`);
  }
  return version.v;
}
