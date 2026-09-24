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
}

/** Locks the envelope row for the rest of the transaction (spec §7.1). RLS applies: another tenant's id reads as missing. */
export async function lockEnvelope(tx: Tx, envelopeId: string): Promise<LockedEnvelopeRow | null> {
  const rows = await tx.$queryRaw<LockedEnvelopeRow[]>`
    SELECT id::text AS id, workspace_id::text AS "workspaceId", status::text AS status, currency,
           start_date::text AS "startDate", end_date::text AS "endDate",
           draft_version_id::text AS "draftVersionId", current_version_id::text AS "currentVersionId",
           row_version AS "rowVersion"
    FROM envelope WHERE id = ${envelopeId}::uuid FOR UPDATE`;
  return rows[0] ?? null;
}
