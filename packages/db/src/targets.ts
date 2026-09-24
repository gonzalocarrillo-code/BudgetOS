import type { Tx } from "./sql.js";

export interface LockedTargetRow {
  id: string;
  workspaceId: string;
  scopeType: "envelope" | "filter";
  envelopeId: string | null;
  metricKey: string;
  startDate: string;
  endDate: string;
  status: string;
  draftVersionId: string | null;
  currentVersionId: string | null;
}

/** Locks the target row for the rest of the transaction (spec §10, mirrors lockEnvelope). RLS applies. */
export async function lockTarget(tx: Tx, targetId: string): Promise<LockedTargetRow | null> {
  const rows = await tx.$queryRaw<LockedTargetRow[]>`
    SELECT id::text AS id, workspace_id::text AS "workspaceId", scope_type AS "scopeType", envelope_id::text AS "envelopeId",
           metric_key AS "metricKey", start_date::text AS "startDate", end_date::text AS "endDate", status,
           draft_version_id::text AS "draftVersionId", current_version_id::text AS "currentVersionId"
    FROM target WHERE id = ${targetId}::uuid FOR UPDATE`;
  return rows[0] ?? null;
}

export interface EffectiveTargetRow {
  metricKey: string;
  targetId: string;
  value: string;
  comparator: string;
  inheritedFrom: string | null;
}

/** effective_target() for each metric on one envelope (spec §10): own target, else the nearest ancestor's. */
export async function effectiveTargets(tx: Tx, envelopeId: string, metricKeys: string[]): Promise<EffectiveTargetRow[]> {
  return tx.$queryRaw<EffectiveTargetRow[]>`
    SELECT k.metric AS "metricKey", et.target_id::text AS "targetId", et.value::text AS value, et.comparator, et.inherited_from::text AS "inheritedFrom"
    FROM unnest(${metricKeys}::text[]) AS k(metric)
    CROSS JOIN LATERAL effective_target(${envelopeId}::uuid, k.metric) et`;
}
