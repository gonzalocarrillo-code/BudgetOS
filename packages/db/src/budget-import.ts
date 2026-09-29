import type { Tx } from "./sql.js";

/** A live budget as the budget import (D-008) matches and checks it. Amounts: envelope and reporting currency. */
export interface ImportEnvelope {
  id: string;
  name: string;
  parentId: string | null;
  dimensionValues: Record<string, string>;
  startDate: string;
  endDate: string;
  currency: string;
  status: string;
  ended: boolean;
  currentVersionId: string | null;
  draftVersionId: string | null;
  amount: string | null;
  amountReporting: string | null;
  allowOverAllocation: boolean;
}

const SELECT = `e.id::text AS id, coalesce(e.display_name, e.name) AS name, e.parent_id::text AS "parentId", e.dimension_values AS "dimensionValues",
  e.start_date::text AS "startDate", e.end_date::text AS "endDate", e.currency, e.status::text AS status, e.ended_at IS NOT NULL AS ended,
  e.current_version_id::text AS "currentVersionId", e.draft_version_id::text AS "draftVersionId",
  v.amount::text AS amount, v.amount_reporting::text AS "amountReporting", e.allow_over_allocation AS "allowOverAllocation"`;

/** Live budgets whose granularities are exactly each tuple (index `i` into `tuples`). */
export async function importEnvelopesByTuple(tx: Tx, workspaceId: string, tuples: Array<Record<string, string>>): Promise<Array<ImportEnvelope & { i: number }>> {
  if (tuples.length === 0) return [];
  const rows = await tx.$queryRawUnsafe<Array<ImportEnvelope & { i: bigint }>>(
    `SELECT t.i, ${SELECT}
     FROM unnest($2::text[]) WITH ORDINALITY AS t(d, i)
     JOIN envelope e ON e.workspace_id = $1::uuid AND e.status <> 'ARCHIVED' AND e.dimension_values @> t.d::jsonb AND e.dimension_values <@ t.d::jsonb
     LEFT JOIN envelope_version v ON v.id = e.current_version_id`,
    workspaceId,
    tuples.map((t) => JSON.stringify(t)),
  );
  return rows.map((r) => ({ ...r, i: Number(r.i) - 1 }));
}

/** Live budgets by id. */
export async function importEnvelopesById(tx: Tx, ids: string[]): Promise<ImportEnvelope[]> {
  if (ids.length === 0) return [];
  return tx.$queryRawUnsafe<ImportEnvelope[]>(
    `SELECT ${SELECT} FROM envelope e LEFT JOIN envelope_version v ON v.id = e.current_version_id WHERE e.id = ANY($1::uuid[]) AND e.status <> 'ARCHIVED'`,
    ids,
  );
}

/** Σ the approved amounts (reporting currency) of each parent's live children. */
export async function liveChildrenApproved(tx: Tx, parentIds: string[]): Promise<Map<string, string>> {
  if (parentIds.length === 0) return new Map();
  const rows = await tx.$queryRawUnsafe<Array<{ parent_id: string; s: string | null }>>(
    `SELECT c.parent_id::text, coalesce(sum(v.amount_reporting), 0)::text AS s FROM envelope c LEFT JOIN envelope_version v ON v.id = c.current_version_id
     WHERE c.parent_id = ANY($1::uuid[]) AND c.status <> 'ARCHIVED' GROUP BY c.parent_id`,
    parentIds,
  );
  return new Map(rows.map((r) => [r.parent_id, r.s ?? "0"]));
}
