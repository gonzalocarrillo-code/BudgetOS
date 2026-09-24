import type { Tx } from "./sql.js";

/** Subscriptions and tag maintenance (spec §13). `subscription` is SQL-owned (0003_functions). */

export async function setSubscription(tx: Tx, s: { workspaceId: string; userId: string; entityType: string; entityId: string; subscribed: boolean }): Promise<boolean> {
  const n = s.subscribed
    ? await tx.$executeRaw`
        INSERT INTO subscription (workspace_id, user_id, entity_type, entity_id) VALUES (${s.workspaceId}::uuid, ${s.userId}::uuid, ${s.entityType}, ${s.entityId}::uuid)
        ON CONFLICT (user_id, entity_type, entity_id) DO NOTHING`
    : await tx.$executeRaw`DELETE FROM subscription WHERE user_id = ${s.userId}::uuid AND entity_type = ${s.entityType} AND entity_id = ${s.entityId}::uuid`;
  return n > 0;
}

/** Users subscribed to any of the entities. */
export async function subscribers(tx: Tx, entities: Array<{ type: string; id: string }>): Promise<string[]> {
  if (entities.length === 0) return [];
  const rows = await tx.$queryRaw<Array<{ user_id: string }>>`
    SELECT DISTINCT s.user_id::text AS user_id FROM subscription s
    JOIN unnest(${entities.map((e) => e.type)}::text[], ${entities.map((e) => e.id)}::uuid[]) AS t(type, id) ON s.entity_type = t.type AND s.entity_id = t.id`;
  return rows.map((r) => r.user_id);
}

/** Moves every entity of `fromId` to `intoId` (an entity already on `intoId` keeps that row), then deletes the emptied tag. */
export async function mergeTag(tx: Tx, fromId: string, intoId: string): Promise<number> {
  await tx.$executeRaw`
    DELETE FROM taggable f USING taggable i
    WHERE f.tag_id = ${fromId}::uuid AND i.tag_id = ${intoId}::uuid AND i.entity_type = f.entity_type AND i.entity_id = f.entity_id`;
  const moved = await tx.$executeRaw`UPDATE taggable SET tag_id = ${intoId}::uuid WHERE tag_id = ${fromId}::uuid`;
  await tx.$executeRaw`DELETE FROM tag WHERE id = ${fromId}::uuid`;
  return moved;
}
