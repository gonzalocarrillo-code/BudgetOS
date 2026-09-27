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

/**
 * Live envelopes whose dimension tuple is exactly one of `tuples` (the envelope that *is* a node).
 * Returns each matching tuple's envelope ids; containment both ways is equality and uses the GIN index.
 */
export async function envelopesByTuple(tx: Tx, workspaceId: string, tuples: Array<Record<string, string>>): Promise<Array<{ i: number; id: string }>> {
  if (tuples.length === 0) return [];
  const rows = await tx.$queryRaw<Array<{ i: bigint; id: string }>>`
    SELECT t.i, e.id::text AS id
    FROM unnest(${tuples.map((t) => JSON.stringify(t))}::text[]) WITH ORDINALITY AS t(d, i)
    JOIN envelope e ON e.workspace_id = ${workspaceId}::uuid AND e.status <> 'ARCHIVED'
      AND e.dimension_values @> t.d::jsonb AND e.dimension_values <@ t.d::jsonb`;
  return rows.map((r) => ({ i: Number(r.i) - 1, id: r.id }));
}

/** Cached nodes at `childDepth` whose parent is one of `parentPaths` ('' = the root). */
export async function rollupChildren(tx: Tx, s: Omit<RollupScope, "dataVersion">, parentPaths: string[], childDepth: number): Promise<Array<{ nodePath: string; measures: Record<string, string | number | null> }>> {
  if (parentPaths.length === 0) return [];
  const parent = childDepth === 1 ? `''` : `regexp_replace(node_path, '/[^/]*$', '')`;
  const rows = await tx.$queryRawUnsafe<Array<{ node_path: string; measures: Record<string, string | number | null> }>>(
    `SELECT node_path, measures FROM rollup_cache
      WHERE workspace_id = $1::uuid AND template_id = $2::uuid AND period_start = $3::date AND period_end = $4::date
        AND node_path <> '' AND cardinality(string_to_array(node_path, '/')) = $5::int AND ${parent} = ANY($6::text[])`,
    s.workspaceId, s.templateId, s.periodStart, s.periodEnd, childDepth, parentPaths,
  );
  return rows.map((r) => ({ nodePath: r.node_path, measures: r.measures }));
}

/**
 * Envelopes under any of `prefixes` of a template's `keys` (a segment is a value code, or '∅' for
 * "no value for this key"): the envelope sets of each value, intersected, less those that have a
 * value for a ∅ key. Codes are resolved to ids first, so Postgres estimates each set from its
 * statistics (ADR-038). The planner's own prefix filter still applies to what this returns.
 */
export async function envelopesUnderPrefixes(tx: Tx, tenant: { workspaceId: string; orgId: string }, keys: string[], prefixes: string[][], none = "∅"): Promise<string[]> {
  if (prefixes.length === 0) return [];
  const dims = await tx.$queryRaw<Array<{ id: string; key: string }>>`
    SELECT id::text, key FROM dimension WHERE org_id = ${tenant.orgId}::uuid AND (workspace_id IS NULL OR workspace_id = ${tenant.workspaceId}::uuid) AND key = ANY(${keys}::text[])`;
  const dimOf = new Map(dims.map((d) => [d.key, d.id]));
  const pairs = [...new Set(prefixes.flatMap((p) => p.flatMap((code, i) => (code === none ? [] : [`${keys[i]}\u0000${code}`]))))];
  const values = pairs.length
    ? await tx.$queryRaw<Array<{ dimension_id: string; code: string; id: string }>>`
        SELECT dv.dimension_id::text, dv.code, dv.id::text FROM dimension_value dv
        WHERE dv.dimension_id = ANY(${[...dimOf.values()]}::uuid[]) AND dv.code = ANY(${pairs.map((p) => p.split("\u0000")[1] as string)}::text[])`
    : [];
  const valueOf = new Map(values.map((v) => [`${v.dimension_id}\u0000${v.code}`, v.id]));
  const params: unknown[] = [];
  const p = (v: unknown) => `$${params.push(v)}`;
  const arms: string[] = [];
  for (const prefix of prefixes) {
    const sets: string[] = [];
    const without: string[] = [];
    let impossible = false;
    prefix.forEach((code, i) => {
      const dimensionId = dimOf.get(keys[i] as string);
      if (code === none) {
        if (dimensionId) without.push(`SELECT envelope_id FROM envelope_dimension WHERE dimension_id = ${p(dimensionId)}::uuid`);
        return;
      }
      const valueId = dimensionId ? valueOf.get(`${dimensionId}\u0000${code}`) : undefined;
      if (!dimensionId || !valueId) impossible = true;
      else sets.push(`SELECT envelope_id FROM envelope_dimension WHERE dimension_id = ${p(dimensionId)}::uuid AND value_id = ${p(valueId)}::uuid`);
    });
    if (impossible) continue;
    const base = sets.length ? sets.join(" INTERSECT ") : `SELECT id AS envelope_id FROM envelope WHERE workspace_id = ${p(tenant.workspaceId)}::uuid`;
    arms.push(without.length ? `(${base}) EXCEPT (${without.join(" UNION ")})` : base);
  }
  if (arms.length === 0) return [];
  const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT DISTINCT envelope_id::text AS id FROM (${arms.map((a) => `(${a})`).join(" UNION ALL ")}) x`, ...params);
  return rows.map((r) => r.id);
}
