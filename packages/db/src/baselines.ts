import type { Tx } from "./sql.js";

/**
 * Phase E (ADR-053): snapshot rows. One INSERT … SELECT copies, for every live budget in scope,
 * the version approved at `asOf` and the budget's structure as it is (parent, granularities, name,
 * dates), which versions do not keep. Written once; never updated.
 */
export async function captureBaselineRows(tx: Tx, args: { baselineId: string; workspaceId: string; asOf: Date; envelopeIds: string[] | null }): Promise<{ rows: number; total: string }> {
  const ids = args.envelopeIds;
  const inserted = await tx.$executeRaw`
    INSERT INTO budget_baseline_row (baseline_id, workspace_id, envelope_id, version_id, amount, amount_reporting, currency, parent_id, name, dimension_values, start_date, end_date, is_leaf)
    SELECT ${args.baselineId}::uuid, e.workspace_id, e.id, v.id, coalesce(v.amount, 0), coalesce(v.amount_reporting, 0), e.currency, e.parent_id,
           coalesce(e.display_name, e.name), e.dimension_values, e.start_date, e.end_date,
           NOT EXISTS (SELECT 1 FROM envelope c WHERE c.parent_id = e.id AND c.status <> 'ARCHIVED')
    FROM envelope e
    LEFT JOIN LATERAL (
      SELECT v.id, v.amount, v.amount_reporting FROM envelope_version v
      WHERE v.envelope_id = e.id AND v.status IN ('APPROVED', 'SUPERSEDED') AND v.approved_at <= ${args.asOf}
      ORDER BY v.approved_at DESC, v.version_no DESC LIMIT 1
    ) v ON true
    WHERE e.workspace_id = ${args.workspaceId}::uuid AND e.status <> 'ARCHIVED'
      AND (${ids === null} OR e.id = ANY(${ids ?? []}::uuid[]))`;
  // The snapshot's total is its roots' amounts: the rows whose parent is not in the snapshot, the
  // same "highest budgets" rule as the Budgets headline (ADR-051).
  const [sum] = await tx.$queryRaw<Array<{ total: string | null }>>`
    SELECT sum(r.amount_reporting)::text AS total FROM budget_baseline_row r
    WHERE r.baseline_id = ${args.baselineId}::uuid
      AND (r.parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM budget_baseline_row p WHERE p.baseline_id = r.baseline_id AND p.envelope_id = r.parent_id))`;
  return { rows: inserted, total: sum?.total ?? "0" };
}

/** A budget and everything under it (live budgets only). */
export async function subtreeIds(tx: Tx, rootId: string): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    WITH RECURSIVE t AS (
      SELECT id FROM envelope WHERE id = ${rootId}::uuid AND status <> 'ARCHIVED'
      UNION ALL
      SELECT c.id FROM envelope c JOIN t ON c.parent_id = t.id WHERE c.status <> 'ARCHIVED'
    ) SELECT id::text FROM t`;
  return rows.map((r) => r.id);
}

export interface ComparedRow {
  envelopeId: string;
  name: string;
  parentId: string | null;
  isLeaf: boolean;
  dimensionValues: Record<string, string>;
  baseline: string | null;
  now: string | null;
  ended: boolean;
}

/**
 * The change report's rows: every budget in the snapshot or, for the envelopes the snapshot's scope
 * covers today, in the working budget (or in a second snapshot). Amounts in reporting currency.
 */
export async function comparedRows(tx: Tx, args: { baselineId: string; workspaceId: string; againstId: string | null; scopeIds: string[] | null }): Promise<ComparedRow[]> {
  const scope = args.scopeIds;
  if (args.againstId !== null) {
    return tx.$queryRaw<ComparedRow[]>`
      SELECT coalesce(a.envelope_id, b.envelope_id)::text AS "envelopeId", coalesce(b.name, a.name) AS name, coalesce(b.parent_id, a.parent_id)::text AS "parentId",
             coalesce(b.is_leaf, a.is_leaf) AS "isLeaf", coalesce(b.dimension_values, a.dimension_values) AS "dimensionValues",
             a.amount_reporting::text AS baseline, b.amount_reporting::text AS now, false AS ended
      FROM (SELECT * FROM budget_baseline_row WHERE baseline_id = ${args.baselineId}::uuid) a
      FULL JOIN (SELECT * FROM budget_baseline_row WHERE baseline_id = ${args.againstId}::uuid) b ON b.envelope_id = a.envelope_id`;
  }
  return tx.$queryRaw<ComparedRow[]>`
    WITH now_rows AS (
      SELECT e.id AS envelope_id, coalesce(e.display_name, e.name) AS name, e.parent_id, e.dimension_values, e.ended_at IS NOT NULL AS ended,
             NOT EXISTS (SELECT 1 FROM envelope c WHERE c.parent_id = e.id AND c.status <> 'ARCHIVED') AS is_leaf,
             coalesce(v.amount_reporting, 0) AS amount_reporting
      FROM envelope e LEFT JOIN envelope_version v ON v.id = e.current_version_id
      WHERE e.workspace_id = ${args.workspaceId}::uuid AND e.status <> 'ARCHIVED'
        AND (${scope === null} OR e.id = ANY(${scope ?? []}::uuid[]))
    )
    SELECT coalesce(a.envelope_id, n.envelope_id)::text AS "envelopeId", coalesce(n.name, a.name) AS name, coalesce(n.parent_id, a.parent_id)::text AS "parentId",
           coalesce(n.is_leaf, a.is_leaf) AS "isLeaf", coalesce(n.dimension_values, a.dimension_values) AS "dimensionValues",
           a.amount_reporting::text AS baseline, n.amount_reporting::text AS now, coalesce(n.ended, false) AS ended
    FROM (SELECT * FROM budget_baseline_row WHERE baseline_id = ${args.baselineId}::uuid) a
    FULL JOIN now_rows n ON n.envelope_id = a.envelope_id`;
}
