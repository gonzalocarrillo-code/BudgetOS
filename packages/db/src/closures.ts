import type { Tx } from "./sql.js";

/**
 * Closure locks (spec §15, ADR-018). SQL-heavy steps of the close and restate commands: an envelope
 * is LOCKED while at least one closed closure covers it, and gets back the status it had before
 * the first of them. A `closing` closure (W3-1: its rows are being written outside the transaction)
 * holds its locks like a closed one; a `failed` or `restated` one holds none.
 */

/** Closure statuses that hold their envelopes' locks and keep facts out of the period. */
export const HOLDING_CLOSURE_STATUSES = ["closing", "closed"] as const;

/** Locks one closure row for a status transition; false when RLS hides it or it does not exist. */
export async function lockClosure(tx: Tx, closureId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text FROM period_closure WHERE id = ${closureId}::uuid FOR UPDATE`;
  return rows.length > 0;
}

/**
 * Locks every non-archived envelope of the workspace that overlaps [start, end] and records it
 * under the closure with its prior status. An envelope another closing or closed closure already
 * locked keeps the status recorded there. Returns the ids locked by this closure.
 */
export async function lockPeriodEnvelopes(tx: Tx, closureId: string, workspaceId: string, period: { start: string; end: string }): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    WITH target AS (
      SELECT e.id, e.status FROM envelope e
      WHERE e.workspace_id = ${workspaceId}::uuid AND e.start_date <= ${period.end}::date AND e.end_date >= ${period.start}::date AND e.status <> 'ARCHIVED'
      ORDER BY e.id
      FOR UPDATE
    ), recorded AS (
      INSERT INTO closure_envelope (closure_id, envelope_id, prior_status)
      SELECT ${closureId}::uuid, t.id,
        CASE WHEN t.status = 'LOCKED' THEN coalesce(
          (SELECT ce.prior_status FROM closure_envelope ce JOIN period_closure pc ON pc.id = ce.closure_id
           WHERE ce.envelope_id = t.id AND pc.status IN ('closing', 'closed') ORDER BY pc.closed_at LIMIT 1),
          'APPROVED'::"EnvelopeStatus") ELSE t.status END
      FROM target t
      RETURNING envelope_id
    )
    UPDATE envelope e SET status = 'LOCKED', row_version = e.row_version + 1, updated_at = now()
    FROM recorded r WHERE e.id = r.envelope_id
    RETURNING e.id::text AS id`;
  return rows.map((r) => r.id);
}

/**
 * After a restatement, a failed close or an abandoned one: envelopes of the closure that no other
 * closing or closed closure covers get their prior status back. Returns the ids unlocked.
 */
export async function unlockClosureEnvelopes(tx: Tx, closureId: string): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE envelope e SET status = ce.prior_status, row_version = e.row_version + 1, updated_at = now()
    FROM closure_envelope ce
    WHERE ce.closure_id = ${closureId}::uuid AND e.id = ce.envelope_id AND e.status = 'LOCKED'
      AND NOT EXISTS (
        SELECT 1 FROM closure_envelope o JOIN period_closure pc ON pc.id = o.closure_id
        WHERE o.envelope_id = e.id AND o.closure_id <> ${closureId}::uuid AND pc.status IN ('closing', 'closed'))
    RETURNING e.id::text AS id`;
  return rows.map((r) => r.id);
}

export interface ClosedPeriod {
  closureId: string;
  key: string;
  start: string;
  end: string;
}

/**
 * The workspace's periods under a closed (not restated) closure, or one being closed (W3-1: its
 * envelopes are locked and its rows are being frozen); fact loads into them are rejected.
 */
export async function closedPeriods(tx: Tx, workspaceId: string): Promise<ClosedPeriod[]> {
  const closures = await tx.periodClosure.findMany({ where: { workspaceId, status: { in: [...HOLDING_CLOSURE_STATUSES] } }, select: { id: true, periodId: true } });
  if (closures.length === 0) return [];
  const periods = new Map((await tx.fiscalPeriod.findMany({ where: { id: { in: closures.map((c) => c.periodId) } } })).map((p) => [p.id, p]));
  return closures.flatMap((c) => {
    const p = periods.get(c.periodId);
    return p ? [{ closureId: c.id, key: p.key, start: p.startDate.toISOString().slice(0, 10), end: p.endDate.toISOString().slice(0, 10) }] : [];
  });
}
