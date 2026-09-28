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

export interface NotificationRow {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

/** The bell (DS-003): the caller's latest notifications in the workspace, and how many are unread. */
export async function listNotifications(tx: Tx, workspaceId: string, userId: string, limit = 20): Promise<{ rows: NotificationRow[]; unread: number }> {
  const rows = await tx.$queryRaw<Array<{ id: string; kind: string; payload: Record<string, unknown>; read_at: Date | null; created_at: Date }>>`
    SELECT id::text AS id, kind, payload, read_at, created_at FROM notification
    WHERE workspace_id = ${workspaceId}::uuid AND user_id = ${userId}::uuid
    ORDER BY created_at DESC LIMIT ${limit}`;
  const [count] = await tx.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM notification WHERE workspace_id = ${workspaceId}::uuid AND user_id = ${userId}::uuid AND read_at IS NULL`;
  return { rows: rows.map((r) => ({ id: r.id, kind: r.kind, payload: r.payload, readAt: r.read_at?.toISOString() ?? null, createdAt: r.created_at.toISOString() })), unread: Number(count?.n ?? 0) };
}

/** Marks the caller's notifications read: the given ids, or every unread one. Returns how many changed. */
export async function markNotificationsRead(tx: Tx, workspaceId: string, userId: string, ids: string[] | null): Promise<number> {
  if (ids !== null && ids.length === 0) return 0;
  return ids === null
    ? tx.$executeRaw`UPDATE notification SET read_at = now() WHERE workspace_id = ${workspaceId}::uuid AND user_id = ${userId}::uuid AND read_at IS NULL`
    : tx.$executeRaw`UPDATE notification SET read_at = now() WHERE workspace_id = ${workspaceId}::uuid AND user_id = ${userId}::uuid AND read_at IS NULL AND id = ANY(${ids}::uuid[])`;
}
