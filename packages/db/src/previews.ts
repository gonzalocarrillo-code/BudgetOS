import type { Tx } from "./sql.js";

/**
 * Bulk-edit and budget-import previews (W1-5, ADR-0072, decision D-2: no Memorystore). Previews
 * live in `bulk_preview`, RLS-scoped to the session's workspace, so any API instance can commit a
 * preview another instance built. Every function here must run inside `withTenant()`: `put`,
 * `get`, `take` and `deleteExpiredPreviews` all read `app.workspace_id` / `app.user_id` from the
 * transaction's session settings rather than taking them as parameters, so a call outside a tenant
 * transaction fails the table's NOT NULL columns instead of silently writing under the wrong
 * tenant.
 */

/** Deletes this workspace's own expired preview rows. RLS already scopes it to the session's
 * visible workspaces; called before every insert as the sweep (no separate cron — previews are
 * small and short-lived, so this keeps the table bounded without a worker pass). */
export async function deleteExpiredPreviews(tx: Tx): Promise<number> {
  return tx.$executeRaw`
    DELETE FROM bulk_preview
    WHERE workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid AND expires_at < now()`;
}

/** Inserts a preview under the session's own workspace and author, expiring in `ttlSeconds`. */
export async function putPreview(tx: Tx, id: string, kind: string, payload: string, ttlSeconds: number): Promise<void> {
  await deleteExpiredPreviews(tx);
  await tx.$executeRaw`
    INSERT INTO bulk_preview (id, workspace_id, author_id, kind, payload, expires_at)
    VALUES (
      ${id},
      nullif(current_setting('app.workspace_id', true), '')::uuid,
      nullif(current_setting('app.user_id', true), '')::uuid,
      ${kind},
      ${payload}::jsonb,
      now() + make_interval(secs => ${ttlSeconds})
    )`;
}

/** The payload as the JSON string `PreviewStore` callers expect, or null if missing, expired, or
 * in a workspace this session cannot see. */
export async function getPreview(tx: Tx, id: string): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ payload: string }>>`
    SELECT payload::text AS payload FROM bulk_preview WHERE id = ${id} AND expires_at > now()`;
  return rows[0]?.payload ?? null;
}

/** Atomic consume: deletes and returns the payload in one statement, so two concurrent commits of
 * the same preview can never both succeed — the second gets null. */
export async function takePreview(tx: Tx, id: string): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ payload: string }>>`
    DELETE FROM bulk_preview WHERE id = ${id} AND expires_at > now() RETURNING payload::text AS payload`;
  return rows[0]?.payload ?? null;
}

export async function deletePreview(tx: Tx, id: string): Promise<void> {
  await tx.$executeRaw`DELETE FROM bulk_preview WHERE id = ${id}`;
}
