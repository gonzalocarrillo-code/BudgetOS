import type { LocalScope, RawReader } from "./outbox.js";

/**
 * Workspace-discovery queries for the local runner's periodic passes (ADR-065 Decision D-3: the
 * poll loop is production, not a stand-in). Moved out of apps/workers so SQL strings stay only in
 * packages/db (AGENTS §4, audit M-8): the runner itself calls these and nothing else raw.
 */

export type { LocalScope } from "./outbox.js";

/** Orgs with at least one deleted, not-yet-purged workspace in the runner's scope (purgePass). */
export async function localOrgsPendingPurge(db: RawReader, scope: LocalScope): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<Array<{ org_id: string }>>(
    `SELECT DISTINCT org_id::text FROM workspace
      WHERE deleted_at IS NOT NULL AND purged_at IS NULL
        AND ($2::text IS NULL AND slug LIKE $1 OR org_id = (SELECT org_id FROM workspace WHERE slug = $2::text))`,
    `${scope.prefix}%`,
    scope.orgFrom,
  );
  return rows.map((r) => r.org_id);
}

/** Orgs with at least one non-deleted workspace in the runner's scope (retentionPass, pacingPass). */
export async function localActiveOrgs(db: RawReader, scope: LocalScope): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<Array<{ org_id: string }>>(
    `SELECT DISTINCT org_id::text FROM workspace
      WHERE deleted_at IS NULL
        AND ($2::text IS NULL AND slug LIKE $1 OR org_id = (SELECT org_id FROM workspace WHERE slug = $2::text))`,
    `${scope.prefix}%`,
    scope.orgFrom,
  );
  return rows.map((r) => r.org_id);
}

/** Every org in the runner's scope, deleted or not (integrityPass, which reads history regardless). */
export async function localAllOrgs(db: RawReader, scope: LocalScope): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<Array<{ org_id: string }>>(
    `SELECT DISTINCT org_id::text FROM workspace
      WHERE ($2::text IS NULL AND slug LIKE $1 OR org_id = (SELECT org_id FROM workspace WHERE slug = $2::text))`,
    `${scope.prefix}%`,
    scope.orgFrom,
  );
  return rows.map((r) => r.org_id);
}

export interface ReindexCandidate {
  id: string;
  orgId: string;
  empty: boolean;
}

/** Active workspaces in the runner's scope, and whether the search index has anything for each yet (reindexPass). */
export async function localWorkspacesForReindex(db: RawReader, scope: LocalScope): Promise<ReindexCandidate[]> {
  return db.$queryRawUnsafe<ReindexCandidate[]>(
    `SELECT w.id::text AS id, w.org_id::text AS "orgId", NOT EXISTS (SELECT 1 FROM search_document d WHERE d.workspace_id = w.id) AS empty
       FROM workspace w
      WHERE w.deleted_at IS NULL AND w.status = 'ACTIVE'
        AND ($2::text IS NULL AND w.slug LIKE $1 OR w.org_id = (SELECT org_id FROM workspace WHERE slug = $2::text))`,
    `${scope.prefix}%`,
    scope.orgFrom,
  );
}
