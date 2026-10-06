import type { Tx } from "./sql.js";

export interface LockedEnvelopeRow {
  id: string;
  workspaceId: string;
  status: "DRAFT" | "PENDING" | "APPROVED" | "LOCKED" | "ARCHIVED";
  currency: string;
  startDate: string;
  endDate: string;
  draftVersionId: string | null;
  currentVersionId: string | null;
  rowVersion: number;
  /** H-011: set once an end is approved; an ended budget is read-only. */
  endedAt?: string | null;
}

/** Locks the envelope row for the rest of the transaction (spec §7.1). RLS applies: another tenant's id reads as missing. */
export async function lockEnvelope(tx: Tx, envelopeId: string): Promise<LockedEnvelopeRow | null> {
  const rows = await tx.$queryRaw<LockedEnvelopeRow[]>`
    SELECT id::text AS id, workspace_id::text AS "workspaceId", status::text AS status, currency,
           start_date::text AS "startDate", end_date::text AS "endDate",
           draft_version_id::text AS "draftVersionId", current_version_id::text AS "currentVersionId",
           row_version AS "rowVersion", ended_at::text AS "endedAt"
    FROM envelope WHERE id = ${envelopeId}::uuid FOR UPDATE`;
  return rows[0] ?? null;
}

/**
 * Serializes changes to the shape of one workspace's tree (W3-5, audit I-15): two moves that would
 * each be fine alone can close a cycle together (A under a descendant of B while B goes under a
 * descendant of A), and row locks on the moved budgets and their parents do not see that. Taken
 * first, before any request or envelope lock; only moves take it. Held until the transaction ends.
 */
export async function lockTreeShape(tx: Tx, workspaceId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('envelope-tree:' || ${workspaceId}, 0))`;
}

/**
 * Serializes budget CSV import commits for one workspace (audit I-16). The plan is built by reading
 * the registry and live budgets, then written a few queries later in the same transaction; without a
 * lock, two concurrent commits can both read "no budget for this tuple yet" and both create it. A
 * session-scoped advisory lock held for the rest of the transaction (released automatically at
 * commit or rollback) makes the second committer wait, then re-read the plan against what the first
 * one just wrote.
 */
export async function lockWorkspaceImport(tx: Tx, workspaceId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`budget-import:${workspaceId}`}, 0))`;
}
