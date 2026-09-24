import { Prisma } from "@prisma/client";
import type { Tx } from "./sql.js";

export interface TimelineRow {
  at: Date;
  /** `at` at full timestamptz precision (microseconds): the cursor must carry this, not a JS Date (milliseconds). */
  atKey: string;
  id: string;
  source: "audit" | "comment" | "alert" | "ingest" | "closure";
  kind: string;
  actorId: string | null;
  actorType: string | null;
  actorName: string | null;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  body: string | null;
}

export interface TimelineQuery {
  workspaceId: string;
  envelopeId: string;
  /** Include the envelope's whole subtree (roll-up timeline, plan §8.3). */
  descendants: boolean;
  limit: number;
  /** Keyset: rows strictly older than (atKey, id); atKey is a previous row's `atKey`. */
  before: { atKey: string; id: string } | null;
}

/**
 * Decision timeline (spec §9.4): UNION ALL of audit_event for the envelope(s), their versions and
 * approval requests; comments on threads anchored to any of those; alerts opened and resolved;
 * ingest runs whose facts matched the envelope(s); closures of their period. Newest first,
 * keyset-paginated on (at, id). Everything comes from stored rows: nothing depends on Slack or email.
 * RLS applies to every table read here.
 */
export async function envelopeTimeline(tx: Tx, q: TimelineQuery): Promise<TimelineRow[]> {
  const after = q.before ? Prisma.sql`WHERE (ev.at, ev.id) < (${q.before.atKey}::timestamptz, ${q.before.id}::text)` : Prisma.empty;
  return tx.$queryRaw<TimelineRow[]>`
    WITH RECURSIVE tree AS (
      SELECT id, period_id FROM envelope WHERE id = ${q.envelopeId}::uuid
      UNION ALL
      SELECT c.id, c.period_id FROM envelope c JOIN tree t ON c.parent_id = t.id WHERE ${q.descendants}::boolean
    ),
    versions AS (SELECT id FROM envelope_version WHERE envelope_id IN (SELECT id FROM tree)),
    requests AS (
      SELECT id FROM approval_request WHERE entity_type = 'envelope_version' AND entity_id IN (SELECT id FROM versions)
    ),
    ev AS (
      SELECT a.occurred_at AS at, a.id::text AS id, 'audit'::text AS source, a.action AS kind,
             a.actor_id AS actor_id, a.actor_type AS actor_type, a.entity_type AS entity_type, a.entity_id AS entity_id,
             a.before AS before, a.after AS after, a.reason AS reason, NULL::text AS body
      FROM audit_event a
      WHERE a.workspace_id = ${q.workspaceId}::uuid
        AND ((a.entity_type = 'envelope' AND a.entity_id IN (SELECT id FROM tree))
          OR (a.entity_type = 'approval_request' AND a.entity_id IN (SELECT id FROM requests)))
      UNION ALL
      SELECT c.created_at, c.id::text, 'comment', CASE WHEN c.parent_comment_id IS NULL THEN 'comment.created' ELSE 'comment.replied' END,
             c.author_id, 'user', th.anchor_type, th.anchor_id,
             NULL, jsonb_build_object('threadId', th.id, 'threadTitle', th.title, 'isBlocking', th.is_blocking, 'threadStatus', th.status), NULL, c.body_md
      FROM comment c JOIN thread th ON th.id = c.thread_id
      WHERE c.deleted_at IS NULL
        AND ((th.anchor_type = 'envelope' AND th.anchor_id IN (SELECT id FROM tree))
          OR (th.anchor_type = 'envelope_version' AND th.anchor_id IN (SELECT id FROM versions))
          OR (th.anchor_type = 'approval_request' AND th.anchor_id IN (SELECT id FROM requests)))
      UNION ALL
      SELECT al.opened_at, al.id::text, 'alert', 'alert.opened', NULL, 'system', 'envelope', al.envelope_id,
             NULL, jsonb_build_object('severity', al.severity, 'metricValue', al.metric_value::text, 'threshold', al.threshold::text, 'ruleId', al.rule_id), NULL, NULL
      FROM alert al WHERE al.envelope_id IN (SELECT id FROM tree)
      UNION ALL
      SELECT al.resolved_at, al.id::text || ':resolved', 'alert', 'alert.resolved', NULL, 'system', 'envelope', al.envelope_id,
             NULL, jsonb_build_object('severity', al.severity, 'ruleId', al.rule_id), NULL, NULL
      FROM alert al WHERE al.envelope_id IN (SELECT id FROM tree) AND al.resolved_at IS NOT NULL
      UNION ALL
      SELECT ir.finished_at, ir.id::text, 'ingest', 'ingest.completed', NULL, 'system', 'ingest_run', ir.id,
             NULL, jsonb_build_object('status', ir.status, 'rowsAccepted', ir.rows_accepted, 'rowsRejected', ir.rows_rejected, 'sourceId', ir.source_id), NULL, NULL
      FROM ingest_run ir
      WHERE ir.finished_at IS NOT NULL
        AND ir.id IN (SELECT DISTINCT sf.source_run_id FROM spend_fact sf WHERE sf.workspace_id = ${q.workspaceId}::uuid AND sf.envelope_id IN (SELECT id FROM tree))
      UNION ALL
      SELECT pc.closed_at, pc.id::text, 'closure', 'closure.' || pc.status, pc.closed_by, 'user', 'period_closure', pc.id,
             NULL, jsonb_build_object('periodId', pc.period_id, 'status', pc.status, 'varianceSummary', pc.variance_summary), NULL, NULL
      FROM period_closure pc WHERE pc.period_id IN (SELECT period_id FROM tree WHERE period_id IS NOT NULL)
    )
    SELECT ev.at, to_char(ev.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "atKey", ev.id, ev.source, ev.kind, ev.actor_id::text AS "actorId", ev.actor_type AS "actorType", u.name AS "actorName",
           ev.entity_type AS "entityType", ev.entity_id::text AS "entityId", ev.before, ev.after, ev.reason, ev.body
    FROM ev LEFT JOIN app_user u ON u.id = ev.actor_id
    ${after}
    ORDER BY ev.at DESC, ev.id DESC
    LIMIT ${q.limit}`;
}
