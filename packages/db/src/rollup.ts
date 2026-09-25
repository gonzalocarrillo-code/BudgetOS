import type { Tx } from "./sql.js";

/** rollup_cache maintenance (spec §19 rollup-worker, plan §5.3). */

export interface RollupNode {
  nodePath: string; // '' = root, 'LATAM/BR/meta'; a missing dimension is '∅'
  envelopeId: string | null;
  measures: Record<string, string | number | null>;
}

export interface RollupScope {
  workspaceId: string;
  templateId: string;
  periodStart: string;
  periodEnd: string;
  dataVersion: number;
}

export async function upsertRollupNodes(tx: Tx, s: RollupScope, nodes: RollupNode[]): Promise<number> {
  if (nodes.length === 0) return 0;
  return tx.$executeRaw`
    INSERT INTO rollup_cache (workspace_id, template_id, node_path, envelope_id, period_start, period_end, measures, data_version, refreshed_at)
    SELECT ${s.workspaceId}::uuid, ${s.templateId}::uuid, p, e::uuid, ${s.periodStart}::date, ${s.periodEnd}::date, m::jsonb, ${s.dataVersion}::bigint, now()
    FROM unnest(${nodes.map((n) => n.nodePath)}::text[], ${nodes.map((n) => n.envelopeId)}::text[], ${nodes.map((n) => JSON.stringify(n.measures))}::text[]) AS t(p, e, m)
    ON CONFLICT (workspace_id, template_id, node_path, period_start, period_end) DO UPDATE SET
      envelope_id = EXCLUDED.envelope_id, measures = EXCLUDED.measures, data_version = EXCLUDED.data_version, refreshed_at = now()`;
}

/** Removes the given node paths (nodes left empty by the change). */
export async function deleteRollupNodes(tx: Tx, s: Omit<RollupScope, "dataVersion">, paths: string[]): Promise<number> {
  if (paths.length === 0) return 0;
  return tx.$executeRaw`
    DELETE FROM rollup_cache WHERE workspace_id = ${s.workspaceId}::uuid AND template_id = ${s.templateId}::uuid
      AND period_start = ${s.periodStart}::date AND period_end = ${s.periodEnd}::date AND node_path = ANY(${paths}::text[])`;
}

/** Full rebuild: drops every node of the template and period not in `keep`. */
export async function deleteRollupNodesExcept(tx: Tx, s: Omit<RollupScope, "dataVersion">, keep: string[]): Promise<number> {
  return tx.$executeRaw`
    DELETE FROM rollup_cache WHERE workspace_id = ${s.workspaceId}::uuid AND template_id = ${s.templateId}::uuid
      AND period_start = ${s.periodStart}::date AND period_end = ${s.periodEnd}::date AND NOT (node_path = ANY(${keep}::text[]))`;
}

/** Periods a template is cached for (the incremental path refreshes each of them). */
export async function cachedPeriods(tx: Tx, workspaceId: string, templateId: string): Promise<Array<{ start: string; end: string }>> {
  return tx.$queryRaw<Array<{ start: string; end: string }>>`
    SELECT DISTINCT period_start::text AS start, period_end::text AS end FROM rollup_cache
    WHERE workspace_id = ${workspaceId}::uuid AND template_id = ${templateId}::uuid ORDER BY 1, 2`;
}
