import type { Tx } from "./sql.js";

/**
 * Reads for the Gantt timeline (spec §23.1, T-037): the targets under each envelope, the markers on
 * each envelope row and the workspace's key dates, all within [from, to] and as of a timestamp.
 * Not the decision timeline (`envelopeTimeline`, spec §9.4). RLS applies to every table read here.
 */

export interface GanttTargetRow {
  /** The envelope row the target lane sits under. */
  envelopeId: string;
  /** 0: the envelope's own target; n: set on the ancestor n levels up (a cap) and inherited. */
  depth: number;
  ownerId: string;
  targetId: string;
  metricKey: string;
  startDate: string;
  endDate: string;
  value: string;
  comparator: string;
}

/**
 * Envelope-scoped targets of each envelope and of its ancestors, overlapping [from, to], with the
 * value that was current at `asOf`: the latest version approved by then (approved versions become
 * SUPERSEDED, so status alone cannot pick it). A target with no version approved by then is left out.
 */
export async function ganttTargets(tx: Tx, workspaceId: string, envelopeIds: string[], from: string, to: string, asOf: Date): Promise<GanttTargetRow[]> {
  if (envelopeIds.length === 0) return [];
  return tx.$queryRaw<GanttTargetRow[]>`
    WITH RECURSIVE chain AS (
      SELECT e.id AS leaf, e.id, e.parent_id, 0 AS depth FROM envelope e WHERE e.id = ANY(${envelopeIds}::uuid[])
      UNION ALL
      SELECT c.leaf, p.id, p.parent_id, c.depth + 1 FROM envelope p JOIN chain c ON p.id = c.parent_id
    )
    SELECT c.leaf::text AS "envelopeId", c.depth AS depth, t.envelope_id::text AS "ownerId", t.id::text AS "targetId", t.metric_key AS "metricKey",
           t.start_date::text AS "startDate", t.end_date::text AS "endDate", v.value::text AS value, v.comparator
    FROM chain c
    JOIN target t ON t.envelope_id = c.id AND t.scope_type = 'envelope' AND t.workspace_id = ${workspaceId}::uuid
    JOIN LATERAL (
      SELECT tv.value, tv.comparator FROM target_version tv
      WHERE tv.target_id = t.id AND tv.status IN ('APPROVED','SUPERSEDED') AND tv.approved_at <= ${asOf}
      ORDER BY tv.approved_at DESC, tv.version_no DESC LIMIT 1
    ) v ON TRUE
    WHERE t.start_date <= ${to}::date AND t.end_date >= ${from}::date AND t.status <> 'archived'
    ORDER BY c.leaf, t.metric_key, c.depth, t.start_date, t.id`;
}

export interface GanttMarkerRow {
  envelopeId: string;
  kind: "approval" | "alert" | "comment" | "version";
  at: string;
  id: string;
  severity: string | null;
}

/**
 * Markers on envelope rows, on or before `asOf` and dated within [from, to] (UTC dates):
 * approval requests on the envelope's versions (at their decision, else their request), versions
 * approved without a request, alerts opened, and threads on the envelope.
 */
export async function ganttMarkers(tx: Tx, envelopeIds: string[], from: string, to: string, asOf: Date): Promise<GanttMarkerRow[]> {
  if (envelopeIds.length === 0) return [];
  return tx.$queryRaw<GanttMarkerRow[]>`
    SELECT m.envelope_id::text AS "envelopeId", m.kind, (m.ts AT TIME ZONE 'UTC')::date::text AS at, m.id, m.severity
    FROM (
      SELECT v.envelope_id, 'approval'::text AS kind, coalesce(r.resolved_at, r.requested_at) AS ts, r.id::text AS id, lower(r.status::text) AS severity
      FROM approval_request r JOIN envelope_version v ON v.id = r.entity_id
      WHERE r.entity_type = 'envelope_version' AND v.envelope_id = ANY(${envelopeIds}::uuid[])
      UNION ALL
      SELECT v.envelope_id, 'version', v.approved_at, v.id::text, NULL
      FROM envelope_version v
      WHERE v.envelope_id = ANY(${envelopeIds}::uuid[]) AND v.approved_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM approval_request r WHERE r.entity_type = 'envelope_version' AND r.entity_id = v.id)
      UNION ALL
      SELECT a.envelope_id, 'alert', a.opened_at, a.id::text, a.severity FROM alert a WHERE a.envelope_id = ANY(${envelopeIds}::uuid[])
      UNION ALL
      SELECT th.anchor_id, 'comment', th.created_at, th.id::text, CASE WHEN th.is_blocking THEN 'blocking' END
      FROM thread th WHERE th.anchor_type = 'envelope' AND th.anchor_id = ANY(${envelopeIds}::uuid[])
    ) m
    WHERE m.ts <= ${asOf} AND (m.ts AT TIME ZONE 'UTC')::date BETWEEN ${from}::date AND ${to}::date
    ORDER BY m.envelope_id, m.ts, m.id`;
}

export interface GanttKeyDateRow {
  at: string;
  label: string;
  kind: "closure";
}

/**
 * Period closures within [from, to], on or before `asOf`: a vertical key date at the day of the close.
 * Only closes that happened (closed, or restated since); a `closing` or `failed` attempt is no key date.
 */
export async function ganttKeyDates(tx: Tx, workspaceId: string, from: string, to: string, asOf: Date): Promise<GanttKeyDateRow[]> {
  return tx.$queryRaw<GanttKeyDateRow[]>`
    SELECT (c.closed_at AT TIME ZONE 'UTC')::date::text AS at, fp.key AS label, 'closure'::text AS kind
    FROM period_closure c JOIN fiscal_period fp ON fp.id = c.period_id
    WHERE c.workspace_id = ${workspaceId}::uuid AND c.closed_at <= ${asOf} AND c.status IN ('closed', 'restated')
      AND (c.closed_at AT TIME ZONE 'UTC')::date BETWEEN ${from}::date AND ${to}::date
    ORDER BY c.closed_at`;
}
