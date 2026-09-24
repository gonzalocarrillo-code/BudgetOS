import type { Tx } from "./sql.js";

/** A search document (spec §12.1). `tsv` and `trigram` are generated columns. */
export interface SearchDoc {
  workspaceId: string;
  entityType: string;
  entityId: string;
  title: string;
  path: string;
  body: string;
  tags: string[];
  dimensionValues: Record<string, string>;
  numericFacets: Record<string, string | null>;
  ownerId: string | null;
  status: string | null;
  periodKey: string | null;
}

/** Upserts documents in one statement (the spec's upsertDocument, batched for re-indexing). */
export async function upsertSearchDocuments(tx: Tx, docs: SearchDoc[]): Promise<number> {
  if (docs.length === 0) return 0;
  return tx.$executeRaw`
    INSERT INTO search_document (workspace_id, entity_type, entity_id, title, path, body, tags, dimension_values, numeric_facets, owner_id, status, period_key, updated_at)
    SELECT w::uuid, t, e::uuid, ti, p, bo, ARRAY(SELECT jsonb_array_elements_text(tg::jsonb)), d::jsonb, f::jsonb, o::uuid, s, pk, now()
    FROM unnest(${docs.map((d) => d.workspaceId)}::text[], ${docs.map((d) => d.entityType)}::text[], ${docs.map((d) => d.entityId)}::text[],
                ${docs.map((d) => d.title)}::text[], ${docs.map((d) => d.path)}::text[], ${docs.map((d) => d.body)}::text[],
                ${docs.map((d) => JSON.stringify(d.tags))}::text[], ${docs.map((d) => JSON.stringify(d.dimensionValues))}::text[],
                ${docs.map((d) => JSON.stringify(d.numericFacets))}::text[], ${docs.map((d) => d.ownerId)}::text[],
                ${docs.map((d) => d.status)}::text[], ${docs.map((d) => d.periodKey)}::text[]) AS x(w, t, e, ti, p, bo, tg, d, f, o, s, pk)
    ON CONFLICT (workspace_id, entity_type, entity_id) DO UPDATE SET title = EXCLUDED.title, path = EXCLUDED.path, body = EXCLUDED.body, tags = EXCLUDED.tags,
      dimension_values = EXCLUDED.dimension_values, numeric_facets = EXCLUDED.numeric_facets, owner_id = EXCLUDED.owner_id, status = EXCLUDED.status,
      period_key = EXCLUDED.period_key, updated_at = now()`;
}

export async function deleteSearchDocuments(tx: Tx, workspaceId: string, entityType: string, entityIds: string[]): Promise<number> {
  if (entityIds.length === 0) return 0;
  return tx.$executeRaw`DELETE FROM search_document WHERE workspace_id = ${workspaceId}::uuid AND entity_type = ${entityType} AND entity_id = ANY(${entityIds}::uuid[])`;
}

export async function searchDocumentIds(tx: Tx, workspaceId: string, entityType: string): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT entity_id::text AS id FROM search_document WHERE workspace_id = ${workspaceId}::uuid AND entity_type = ${entityType}`;
  return rows.map((r) => r.id);
}
