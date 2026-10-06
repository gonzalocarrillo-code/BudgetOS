-- W3-1 (audit I-4, ADR-018 addendum 2026-10-05): the period close runs in two transactions with the
-- BigQuery write in between. A closure is `closing` while its rows are written, then `closed`, or
-- `failed` (sink error, or abandoned when stale) with its envelopes unlocked.
-- 1. period_closure.error: why a close failed.
-- 2. period_closure_one_closed also covers `closing`, so two concurrent closes of one period cannot
--    both start. Expand-safe: the previous code only writes `closed` and `restated`, and a period
--    never has a `closing` row before the new code runs.
--
-- Reverse: DROP INDEX period_closure_one_closed;
--          CREATE UNIQUE INDEX period_closure_one_closed ON period_closure (workspace_id, period_id) WHERE status = 'closed';
--          ALTER TABLE period_closure DROP COLUMN error;
ALTER TABLE period_closure ADD COLUMN IF NOT EXISTS error text;

DROP INDEX IF EXISTS period_closure_one_closed;
CREATE UNIQUE INDEX IF NOT EXISTS period_closure_one_closed ON period_closure (workspace_id, period_id) WHERE status IN ('closing', 'closed');
