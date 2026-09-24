import type { Tx } from "./sql.js";

export interface NotificationInput {
  workspaceId: string;
  userId: string;
  kind: string; // mention | approval | alert | …
  payload: unknown;
}

/** In-app notification row (spec §19 notify-worker; table from 0003_functions). */
export async function insertNotification(tx: Tx, n: NotificationInput): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO notification (workspace_id, user_id, kind, payload)
    VALUES (${n.workspaceId}::uuid, ${n.userId}::uuid, ${n.kind}, ${JSON.stringify(n.payload)}::jsonb)
    RETURNING id::text AS id`;
  const row = rows[0];
  if (row === undefined) throw new Error("notification insert returned no row");
  return row.id;
}
