import type { Tx } from "./sql.js";

export interface OpenAlertInput {
  id: string;
  workspaceId: string;
  ruleId: string;
  envelopeId: string;
  severity: string;
  metricValue: string;
  threshold: string;
  context: unknown;
  ownerId: string | null;
}

/**
 * Opens an alert unless one is already open for the rule and envelope (partial unique index
 * alert_one_open_per_rule_envelope, migration 20260924090000). Returns false when one was open.
 */
export async function openAlert(tx: Tx, a: OpenAlertInput): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO alert (id, workspace_id, rule_id, envelope_id, severity, status, metric_value, threshold, context, owner_id)
    VALUES (${a.id}::uuid, ${a.workspaceId}::uuid, ${a.ruleId}::uuid, ${a.envelopeId}::uuid, ${a.severity}, 'OPEN'::"AlertStatus",
            ${a.metricValue}::numeric, ${a.threshold}::numeric, ${JSON.stringify(a.context)}::jsonb, ${a.ownerId}::uuid)
    ON CONFLICT (rule_id, envelope_id) WHERE status IN ('OPEN', 'ACKNOWLEDGED', 'SNOOZED') DO NOTHING
    RETURNING id::text AS id`;
  return rows.length === 1;
}

export interface RuleStateInput {
  envelopeId: string;
  consecutiveDays: number;
  lastEvalDate: string; // yyyy-MM-dd
  lastValue: string | null;
  priorDays: number;
}

/** One statement for a rule's evaluated envelopes (the job runs every 15 minutes over every envelope in scope). */
export async function saveRuleStates(tx: Tx, ruleId: string, rows: RuleStateInput[]): Promise<number> {
  if (rows.length === 0) return 0;
  return tx.$executeRaw`
    INSERT INTO rule_state (rule_id, envelope_id, consecutive_days, last_eval_date, last_value, prior_days)
    SELECT ${ruleId}::uuid, e::uuid, c, d::date, v::numeric, p
    FROM unnest(${rows.map((r) => r.envelopeId)}::text[], ${rows.map((r) => r.consecutiveDays)}::int[], ${rows.map((r) => r.lastEvalDate)}::text[],
                ${rows.map((r) => r.lastValue)}::text[], ${rows.map((r) => r.priorDays)}::int[]) AS t(e, c, d, v, p)
    ON CONFLICT (rule_id, envelope_id) DO UPDATE SET
      consecutive_days = EXCLUDED.consecutive_days, last_eval_date = EXCLUDED.last_eval_date,
      last_value = EXCLUDED.last_value, prior_days = EXCLUDED.prior_days`;
}
