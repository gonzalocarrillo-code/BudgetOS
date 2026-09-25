import { SqlBuilder } from "./sql-builder.js";

/**
 * Tree read from rollup_cache (plan §5.3: roll-ups are not computed on read). Rows come in tree
 * order (depth-first: a node, then its children by path segment) with their depth. `parentPath`
 * narrows to one node's children (lazy expansion); `maxDepth` caps the depth.
 */
export interface TreeRequest {
  workspaceId: string;
  templateId: string;
  period: { start: string; end: string };
  parentPath?: string | undefined;
  maxDepth?: number | undefined;
}

export interface CompiledTree {
  sql: string;
  values: unknown[];
}

export const ROOT_PATH = "";
export const NONE_SEGMENT = "∅";
export const nodeDepth = (path: string) => (path === ROOT_PATH ? 0 : path.split("/").length);

export function compileTree(r: TreeRequest): CompiledTree {
  const b = new SqlBuilder();
  const depth = `CASE WHEN node_path = '' THEN 0 ELSE cardinality(string_to_array(node_path, '/')) END`;
  const conds = [
    `workspace_id = ${b.p(r.workspaceId)}::uuid`,
    `template_id = ${b.p(r.templateId)}::uuid`,
    `period_start = ${b.p(r.period.start)}::date`,
    `period_end = ${b.p(r.period.end)}::date`,
  ];
  if (r.parentPath !== undefined) {
    conds.push(r.parentPath === ROOT_PATH ? `${depth} = 1` : `node_path LIKE ${b.p(`${r.parentPath.replace(/[\\%_]/g, "\\$&")}/%`)}::text AND ${depth} = ${b.p(nodeDepth(r.parentPath) + 1)}::int`);
  }
  if (r.maxDepth !== undefined) conds.push(`${depth} <= ${b.p(r.maxDepth)}::int`);
  const sql = `
    SELECT node_path, envelope_id::text AS envelope_id, measures, data_version, ${depth} AS depth
    FROM rollup_cache WHERE ${conds.join(" AND ")}
    ORDER BY string_to_array(node_path, '/') COLLATE "C"`;
  return { sql, values: b.values };
}
