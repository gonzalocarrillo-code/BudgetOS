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

export interface BaselineTreeRow {
  envelopeId: string;
  parentId: string | null;
  depth: number;
  name: string;
  isLeaf: boolean;
  amount: string;
  amountReporting: string;
  currency: string;
  versionId: string | null;
  dimensionValues: Record<string, string>;
  startDate: string;
  endDate: string;
  /** The budget's approved amount now (reporting currency); null when it no longer exists. */
  now: string | null;
  /** now − then, reporting currency (a gone budget counts as 0 now). */
  change: string;
  ended: boolean;
}

/**
 * A snapshot's rows as the tree they were saved in: parents before children, siblings by name,
 * each with its depth (roots are the rows whose parent is outside the snapshot). Walks the frozen
 * parent links, so a budget moved since still sits where it was.
 */
export async function baselineTree(tx: Tx, baselineId: string, limit: number): Promise<BaselineTreeRow[]> {
  return tx.$queryRaw<BaselineTreeRow[]>`
    WITH RECURSIVE r AS (SELECT * FROM budget_baseline_row WHERE baseline_id = ${baselineId}::uuid),
    t AS (
      SELECT r.*, 0 AS depth, ARRAY[lower(r.name), r.envelope_id::text] AS sort_path FROM r
      WHERE r.parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM r p WHERE p.envelope_id = r.parent_id)
      UNION ALL
      SELECT c.*, t.depth + 1, t.sort_path || ARRAY[lower(c.name), c.envelope_id::text] FROM r c JOIN t ON c.parent_id = t.envelope_id
    )
    SELECT t.envelope_id::text AS "envelopeId", t.parent_id::text AS "parentId", t.depth, t.name, t.is_leaf AS "isLeaf",
           t.amount::text AS amount, t.amount_reporting::text AS "amountReporting", t.currency, t.version_id::text AS "versionId",
           t.dimension_values AS "dimensionValues", t.start_date::text AS "startDate", t.end_date::text AS "endDate",
           v.amount_reporting::text AS now, (coalesce(v.amount_reporting, 0) - t.amount_reporting)::text AS change, coalesce(e.ended_at IS NOT NULL, false) AS ended
    FROM t
    LEFT JOIN envelope e ON e.id = t.envelope_id AND e.status <> 'ARCHIVED'
    LEFT JOIN envelope_version v ON v.id = e.current_version_id
    ORDER BY t.sort_path
    LIMIT ${limit}`;
}
