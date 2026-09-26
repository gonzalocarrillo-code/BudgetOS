import type { AuditEventInput } from "./facts.types.js";
import type { Tx } from "./sql.js";

/**
 * Set-based SQL for bulk edit (spec §7.4): one statement per step instead of one per envelope, so a
 * 10k-row commit stays well under the 10 s budget. RLS applies to every statement.
 */

export interface BulkHeadRow {
  id: string;
  workspaceId: string;
  parentId: string | null;
  name: string;
  status: string;
  currency: string;
  startDate: string;
  endDate: string;
  dimensionValues: Record<string, string>;
  currentVersionId: string | null;
  draftVersionId: string | null;
  /** draft ?? current: the version the user sees and the bulk edit is based on. */
  headVersionId: string | null;
  headStatus: string | null;
  headAmount: string | null;
  currentAmountReporting: string | null;
  maxVersionNo: number;
}

export async function loadBulkHeads(tx: Tx, ids: string[]): Promise<BulkHeadRow[]> {
  if (ids.length === 0) return [];
  return tx.$queryRaw<BulkHeadRow[]>`
    SELECT e.id::text AS id, e.workspace_id::text AS "workspaceId", e.parent_id::text AS "parentId", e.name,
           e.status::text AS status, e.currency, e.start_date::text AS "startDate", e.end_date::text AS "endDate",
           e.dimension_values AS "dimensionValues",
           e.current_version_id::text AS "currentVersionId", e.draft_version_id::text AS "draftVersionId",
           coalesce(e.draft_version_id, e.current_version_id)::text AS "headVersionId",
           h.status::text AS "headStatus", h.amount::text AS "headAmount", c.amount_reporting::text AS "currentAmountReporting",
           coalesce((SELECT max(x.version_no) FROM envelope_version x WHERE x.envelope_id = e.id), 0)::int AS "maxVersionNo"
    FROM envelope e
    LEFT JOIN envelope_version h ON h.id = coalesce(e.draft_version_id, e.current_version_id)
    LEFT JOIN envelope_version c ON c.id = e.current_version_id
    WHERE e.id = ANY(${ids}::uuid[])`;
}

/** Row locks in id order (deadlock-free across concurrent bulk commits). */
export async function lockEnvelopes(tx: Tx, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx.$queryRaw`SELECT id FROM envelope WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
}

/** Points each envelope at its new draft; status stays APPROVED when there is an approved version. */
export async function setDraftPointers(tx: Tx, rows: Array<{ envelopeId: string; versionId: string }>, status: "DRAFT_OR_APPROVED" | "PENDING"): Promise<void> {
  if (rows.length === 0) return;
  const envs = rows.map((r) => r.envelopeId);
  const vers = rows.map((r) => r.versionId);
  if (status === "PENDING") {
    await tx.$executeRaw`
      UPDATE envelope e SET draft_version_id = v.vid, status = 'PENDING', row_version = e.row_version + 1, updated_at = now()
      FROM unnest(${envs}::uuid[], ${vers}::uuid[]) AS v(eid, vid) WHERE e.id = v.eid`;
  } else {
    await tx.$executeRaw`
      UPDATE envelope e SET draft_version_id = v.vid,
             status = CASE WHEN e.status = 'APPROVED' THEN 'APPROVED'::"EnvelopeStatus" ELSE 'DRAFT'::"EnvelopeStatus" END,
             row_version = e.row_version + 1, updated_at = now()
      FROM unnest(${envs}::uuid[], ${vers}::uuid[]) AS v(eid, vid) WHERE e.id = v.eid`;
  }
}

/** Supersedes open drafts (never deletes them). */
export async function supersedeDrafts(tx: Tx, versionIds: string[]): Promise<void> {
  if (versionIds.length === 0) return;
  await tx.$executeRaw`UPDATE envelope_version SET status = 'SUPERSEDED', superseded_at = now() WHERE id = ANY(${versionIds}::uuid[]) AND status = 'DRAFT'`;
}

/**
 * One INSERT for many audit rows (one per envelope in a bulk commit). Nullable uuid arrays go
 * through text[]: Prisma binds an all-null array as integer[], which does not cast to uuid[].
 */
export async function auditMany(tx: Tx, events: AuditEventInput[]): Promise<void> {
  if (events.length === 0) return;
  const col = <K extends keyof AuditEventInput>(k: K) => events.map((e) => e[k] ?? null);
  const json = (k: "before" | "after") => events.map((e) => JSON.stringify(e[k] ?? null));
  await tx.$executeRaw`
    INSERT INTO audit_event (workspace_id, actor_id, actor_type, action, entity_type, entity_id, before, after, reason, request_id)
    SELECT w, a, t, act, et, eid, b::jsonb, af::jsonb, r, rq
    FROM unnest(${col("workspaceId")}::text[]::uuid[], ${col("actorId")}::text[]::uuid[], ${col("actorType")}::text[], ${col("action")}::text[],
                ${col("entityType")}::text[], ${col("entityId")}::text[]::uuid[], ${json("before")}::text[], ${json("after")}::text[],
                ${col("reason")}::text[], ${col("requestId")}::text[]) AS x(w, a, t, act, et, eid, b, af, r, rq)`;
}

/** For cap previews: each parent's approved amount and its children's approved amounts (reporting currency). */
export async function capInputs(tx: Tx, parentIds: string[]): Promise<Array<{ parentId: string; parentAmount: string | null; allowOverAllocation: boolean; childId: string; childAmount: string | null }>> {
  if (parentIds.length === 0) return [];
  return tx.$queryRaw`
    SELECT p.id::text AS "parentId", pv.amount_reporting::text AS "parentAmount", p.allow_over_allocation AS "allowOverAllocation",
           c.id::text AS "childId", cv.amount_reporting::text AS "childAmount"
    FROM envelope p
    LEFT JOIN envelope_version pv ON pv.id = p.current_version_id
    JOIN envelope c ON c.parent_id = p.id
    LEFT JOIN envelope_version cv ON cv.id = c.current_version_id
    WHERE p.id = ANY(${parentIds}::uuid[])`;
}

/** Actual spend to date per envelope (reporting currency), for `redistribute by_last_actuals`. */
export async function actualsByEnvelope(tx: Tx, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.$queryRaw<Array<{ id: string; s: string }>>`
    SELECT envelope_id::text AS id, sum(amount_reporting)::text AS s FROM spend_fact
    WHERE envelope_id = ANY(${ids}::uuid[]) GROUP BY envelope_id`;
  return new Map(rows.map((r) => [r.id, r.s]));
}

/**
 * `copy_previous_period`: for each envelope, the latest earlier envelope with the same dimension
 * tuple that ended before this one starts, and its approved amount (envelope currency).
 */
export async function previousPeriodAmounts(tx: Tx, ids: string[]): Promise<Map<string, { previousId: string; amount: string | null; currency: string }>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.$queryRaw<Array<{ id: string; previousId: string; amount: string | null; currency: string }>>`
    SELECT DISTINCT ON (e.id) e.id::text AS id, p.id::text AS "previousId", pv.amount::text AS amount, p.currency
    FROM envelope e
    JOIN envelope p ON p.workspace_id = e.workspace_id AND p.id <> e.id AND p.dimension_values = e.dimension_values AND p.end_date < e.start_date
    LEFT JOIN envelope_version pv ON pv.id = p.current_version_id
    WHERE e.id = ANY(${ids}::uuid[])
    ORDER BY e.id, p.end_date DESC`;
  return new Map(rows.map((r) => [r.id, { previousId: r.previousId, amount: r.amount, currency: r.currency }]));
}

/** Envelope name path root … self for many envelopes in one recursive query. */
/** Each envelope's path of names, root first; a display name (T-036) where a display template renders one. */
export async function envelopePaths(tx: Tx, ids: string[]): Promise<Map<string, string[]>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.$queryRaw<Array<{ id: string; path: string[] }>>`
    WITH RECURSIVE up AS (
      SELECT e.id AS start, e.id, e.parent_id, ARRAY[coalesce(e.display_name, e.name)] AS path, 0 AS depth FROM envelope e WHERE e.id = ANY(${ids}::uuid[])
      UNION ALL
      SELECT up.start, p.id, p.parent_id, coalesce(p.display_name, p.name) || up.path, up.depth + 1 FROM envelope p JOIN up ON p.id = up.parent_id WHERE up.depth < 32
    )
    SELECT DISTINCT ON (start) start::text AS id, path FROM up ORDER BY start, depth DESC`;
  return new Map(rows.map((r) => [r.id, r.path]));
}

/**
 * Closes the versions of a bulk request that ended without approval (spec §9.3 for bulk_change).
 * REJECTED / WITHDRAWN: versions keep that status and envelopes drop the draft pointer.
 * CHANGES_REQUESTED: versions return to DRAFT and stay the envelopes' drafts.
 */
export async function closeBulkVersions(tx: Tx, versionIds: string[], outcome: "REJECTED" | "WITHDRAWN" | "CHANGES_REQUESTED"): Promise<void> {
  if (versionIds.length === 0) return;
  const status = outcome === "CHANGES_REQUESTED" ? "DRAFT" : outcome;
  await tx.$executeRaw`UPDATE envelope_version SET status = ${status}::"VersionStatus" WHERE id = ANY(${versionIds}::uuid[]) AND status = 'PENDING'`;
  await tx.$executeRaw`
    UPDATE envelope SET
      status = CASE WHEN current_version_id IS NOT NULL THEN 'APPROVED'::"EnvelopeStatus" ELSE 'DRAFT'::"EnvelopeStatus" END,
      draft_version_id = CASE WHEN ${outcome} = 'CHANGES_REQUESTED' THEN draft_version_id ELSE NULL END,
      row_version = row_version + 1, updated_at = now()
    WHERE draft_version_id = ANY(${versionIds}::uuid[])`;
}

export interface BulkVersionRow {
  id: string;
  envelopeId: string;
  versionNo: number;
  amount: string;
  amountReporting: string;
  fxRateId: string | null;
  basedOnVersionId: string | null;
  /** Head version whose phasing shape the new version keeps (null: no phasing). */
  headVersionId: string | null;
}

/**
 * Inserts bulk DRAFT versions with one statement, then their phasing with another: each new
 * version keeps its head's monthly shape, months rounded to the cent and the rounding difference on
 * the last month, so every version's phasing sums exactly to its amount (spec §7.1 phasing rule).
 */
export async function insertBulkVersions(tx: Tx, rows: BulkVersionRow[], createdBy: string, rationale: string): Promise<void> {
  if (rows.length === 0) return;
  const c = <K extends keyof BulkVersionRow>(k: K) => rows.map((r) => r[k]);
  await tx.$executeRaw`
    INSERT INTO envelope_version (id, envelope_id, version_no, amount, amount_reporting, fx_rate_id, status, based_on_version_id, rationale, created_by)
    SELECT id, env, no, amt, rep, fx, 'DRAFT', based, ${rationale}, ${createdBy}::uuid
    FROM unnest(${c("id")}::uuid[], ${c("envelopeId")}::uuid[], ${c("versionNo")}::int[], ${c("amount")}::numeric[], ${c("amountReporting")}::numeric[],
                ${c("fxRateId")}::text[]::uuid[], ${c("basedOnVersionId")}::text[]::uuid[]) AS x(id, env, no, amt, rep, fx, based)`;
  const withShape = rows.filter((r) => r.headVersionId !== null);
  if (withShape.length === 0) return;
  await tx.$executeRaw`
    WITH m AS (
      SELECT * FROM unnest(${withShape.map((r) => r.id)}::uuid[], ${withShape.map((r) => r.headVersionId)}::text[]::uuid[], ${withShape.map((r) => r.amount)}::numeric[]) AS x(vid, hid, amt)
    ), s AS (
      SELECT m.vid, p.month, p.amount, m.amt,
             sum(abs(p.amount)) OVER (PARTITION BY m.vid) AS total,
             count(*) OVER (PARTITION BY m.vid) AS n,
             row_number() OVER (PARTITION BY m.vid ORDER BY p.month DESC) AS rn
      FROM m JOIN envelope_phasing p ON p.version_id = m.hid
    ), r AS (
      SELECT vid, month, rn, amt, CASE WHEN total = 0 THEN round(amt / n, 2) ELSE round(abs(amount) * amt / total, 2) END AS scaled FROM s
    )
    INSERT INTO envelope_phasing (version_id, month, amount)
    SELECT vid, month, CASE WHEN rn = 1 THEN amt - (sum(scaled) OVER (PARTITION BY vid) - scaled) ELSE scaled END FROM r`;
}

export interface BulkChangeRow {
  id: string;
  kind: "edit" | "split" | "merge";
  versionIds: string[];
  archiveIds: string[];
  createdIds: string[];
  createdBy: string;
}

export async function loadBulkChange(tx: Tx, id: string): Promise<BulkChangeRow | null> {
  const [row] = await tx.$queryRaw<BulkChangeRow[]>`
    SELECT id::text AS id, kind, version_ids::text[] AS "versionIds", archive_ids::text[] AS "archiveIds",
           created_ids::text[] AS "createdIds", created_by::text AS "createdBy"
    FROM bulk_change WHERE id = ${id}::uuid`;
  return row ?? null;
}

export async function insertBulkChange(
  tx: Tx,
  row: { id: string; workspaceId: string; kind: "edit" | "split" | "merge"; versionIds: string[]; archiveIds?: string[]; createdIds?: string[]; createdBy: string },
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO bulk_change (id, workspace_id, kind, version_ids, archive_ids, created_ids, created_by)
    VALUES (${row.id}::uuid, ${row.workspaceId}::uuid, ${row.kind}, ${row.versionIds}::uuid[], ${row.archiveIds ?? []}::text[]::uuid[],
            ${row.createdIds ?? []}::text[]::uuid[], ${row.createdBy}::uuid)`;
}

/** Archives envelopes (split / merge sources after approval, never-approved parts after a rejection). */
export async function archiveEnvelopes(tx: Tx, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx.$executeRaw`UPDATE envelope SET status = 'ARCHIVED', draft_version_id = NULL, row_version = row_version + 1, updated_at = now() WHERE id = ANY(${ids}::uuid[])`;
}
