import type { Tx } from "./sql.js";

/**
 * Reads behind Home's desk (HO-005, docs/HOME_OVERVIEW_PLAN.md §3.1): what the signed-in person left
 * half done, what they did last, and where a budget sits in the tree. Callers apply read scope.
 */

export interface LineageStep {
  id: string;
  name: string;
  ownerId: string | null;
}

/** Each envelope's chain up to its top-level budget, itself first and the top-level budget last. */
export async function envelopeLineage(tx: Tx, envelopeIds: readonly string[]): Promise<Map<string, LineageStep[]>> {
  if (envelopeIds.length === 0) return new Map();
  const rows = await tx.$queryRaw<Array<{ start: string; id: string; name: string; owner_id: string | null }>>`
    WITH RECURSIVE up AS (
      SELECT e.id AS start, e.id, e.parent_id, coalesce(e.display_name, e.name) AS name, e.owner_id, 0 AS depth FROM envelope e WHERE e.id = ANY(${[...envelopeIds]}::uuid[])
      UNION ALL
      SELECT up.start, p.id, p.parent_id, coalesce(p.display_name, p.name), p.owner_id, up.depth + 1 FROM envelope p JOIN up ON p.id = up.parent_id WHERE up.depth < 32
    )
    SELECT start::text, id::text, name, owner_id::text FROM up ORDER BY start, depth`;
  const out = new Map<string, LineageStep[]>();
  for (const r of rows) out.set(r.start, [...(out.get(r.start) ?? []), { id: r.id, name: r.name, ownerId: r.owner_id }]);
  return out;
}

/** Every envelope under these budgets, the budgets themselves included (live or not; the caller filters). */
export async function descendantIds(tx: Tx, rootIds: readonly string[]): Promise<Set<string>> {
  if (rootIds.length === 0) return new Set();
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    WITH RECURSIVE down AS (
      SELECT e.id, 0 AS depth FROM envelope e WHERE e.id = ANY(${[...rootIds]}::uuid[])
      UNION ALL
      SELECT c.id, down.depth + 1 FROM envelope c JOIN down ON c.parent_id = down.id WHERE down.depth < 32
    )
    SELECT DISTINCT id::text FROM down`;
  return new Set(rows.map((r) => r.id));
}

export interface UnsentDraft {
  envelopeId: string;
  versionId: string;
  name: string;
  createdAt: string;
}

/**
 * Drafts a person saved and never sent for approval: the open draft of a live budget, written by them
 * and still DRAFT (sending makes it PENDING). Newest first.
 */
export async function unsentDrafts(tx: Tx, workspaceId: string, userId: string, limit: number): Promise<{ count: number; items: UnsentDraft[] }> {
  const rows = await tx.$queryRaw<Array<{ envelope_id: string; version_id: string; name: string; created_at: Date; total: bigint }>>`
    SELECT e.id::text AS envelope_id, v.id::text AS version_id, coalesce(e.display_name, e.name) AS name, v.created_at, count(*) OVER () AS total
    FROM envelope e JOIN envelope_version v ON v.id = e.draft_version_id
    WHERE e.workspace_id = ${workspaceId}::uuid AND e.status <> 'ARCHIVED' AND e.ended_at IS NULL
      AND v.status = 'DRAFT' AND v.created_by = ${userId}::uuid
    ORDER BY v.created_at DESC, v.id DESC
    LIMIT ${limit}`;
  return { count: Number(rows[0]?.total ?? 0), items: rows.map((r) => ({ envelopeId: r.envelope_id, versionId: r.version_id, name: r.name, createdAt: r.created_at.toISOString() })) };
}

export interface Activity {
  entityType: string;
  entityId: string;
  action: string;
  at: string;
}

/** What a person did last: the latest audit event per entity they acted on, newest first. */
export async function recentActivity(tx: Tx, workspaceId: string, actorId: string, entityTypes: readonly string[], limit: number): Promise<Activity[]> {
  const rows = await tx.$queryRaw<Array<{ entity_type: string; entity_id: string; action: string; at: Date }>>`
    SELECT entity_type, entity_id, action, at FROM (
      SELECT DISTINCT ON (entity_type, entity_id) entity_type, entity_id::text AS entity_id, action, occurred_at AS at
      FROM audit_event
      WHERE workspace_id = ${workspaceId}::uuid AND actor_id = ${actorId}::uuid AND entity_type = ANY(${[...entityTypes]}::text[])
      ORDER BY entity_type, entity_id, occurred_at DESC
    ) latest
    ORDER BY at DESC LIMIT ${limit}`;
  return rows.map((r) => ({ entityType: r.entity_type, entityId: r.entity_id, action: r.action, at: r.at.toISOString() }));
}

export interface FailedRun {
  sourceId: string;
  sourceName: string;
  runId: string;
  at: string;
  error: string | null;
}

/** Active sources whose latest run failed since `since` (a data admin's to-do). */
export async function failedRuns(tx: Tx, workspaceId: string, since: Date): Promise<FailedRun[]> {
  const rows = await tx.$queryRaw<Array<{ source_id: string; name: string; run_id: string; at: Date; error: string | null }>>`
    SELECT s.id::text AS source_id, s.name, r.id::text AS run_id, coalesce(r.finished_at, r.started_at) AS at, r.summary->>'error' AS error
    FROM data_source s
    JOIN LATERAL (SELECT * FROM ingest_run x WHERE x.source_id = s.id ORDER BY x.started_at DESC LIMIT 1) r ON TRUE
    WHERE s.workspace_id = ${workspaceId}::uuid AND s.is_active AND r.status = 'failed' AND r.started_at >= ${since}
    ORDER BY r.started_at DESC`;
  return rows.map((r) => ({ sourceId: r.source_id, sourceName: r.name, runId: r.run_id, at: r.at.toISOString(), error: r.error }));
}

/** Live budgets in a period that are not settled yet: an open draft, or waiting for approval. */
export async function unsettledInPeriod(tx: Tx, workspaceId: string, period: { start: string; end: string }): Promise<{ drafts: number; pending: number }> {
  const [r] = await tx.$queryRaw<Array<{ drafts: bigint; pending: bigint }>>`
    SELECT count(*) FILTER (WHERE e.draft_version_id IS NOT NULL AND e.status <> 'PENDING') AS drafts,
           count(*) FILTER (WHERE e.status = 'PENDING') AS pending
    FROM envelope e
    WHERE e.workspace_id = ${workspaceId}::uuid AND e.status <> 'ARCHIVED' AND e.ended_at IS NULL
      AND e.start_date <= ${period.end}::date AND e.end_date >= ${period.start}::date`;
  return { drafts: Number(r?.drafts ?? 0), pending: Number(r?.pending ?? 0) };
}
