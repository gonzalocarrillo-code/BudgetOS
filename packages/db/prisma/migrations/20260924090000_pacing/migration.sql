-- T-018 pacing (spec §11, ADR-012).
-- 1. At most one open alert (OPEN, ACKNOWLEDGED or SNOOZED) per rule and envelope, enforced by the
--    database so two evaluators running at once cannot both open one. The evaluator inserts with
--    ON CONFLICT … DO NOTHING against this index.
-- 2. rule_state.prior_days: the breach streak through the day before last_eval_date. The job runs
--    every 15 minutes, so a same-day re-evaluation recomputes today from prior_days instead of adding
--    a day, and an unbreached run earlier today does not lose yesterday's streak.
--
-- Reverse: DROP INDEX alert_one_open_per_rule_envelope; ALTER TABLE rule_state DROP COLUMN prior_days;
CREATE UNIQUE INDEX IF NOT EXISTS alert_one_open_per_rule_envelope ON alert (rule_id, envelope_id)
  WHERE status IN ('OPEN', 'ACKNOWLEDGED', 'SNOOZED');
ALTER TABLE rule_state ADD COLUMN IF NOT EXISTS prior_days int NOT NULL DEFAULT 0;
