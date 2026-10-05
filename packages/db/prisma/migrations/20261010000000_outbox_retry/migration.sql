-- W1-2 (audit I-1, I-7; ADR-010 Decision D-3, 2026-10-05): the local-runner poll loop is the
-- production design for the single-org deployment (budgetos-worker, ADR-065), not a stand-in for a
-- Pub/Sub path that is never deployed. It needs its own retry bookkeeping: a row whose handlers
-- threw must stay unpublished, back off, and dead-letter after too many failures instead of being
-- marked published regardless (I-1), or re-tried every poll forever with no visible record (I-7).
-- budget_publisher (ADR-010) gets the same columns granted alongside its existing
-- UPDATE (published_at), so W2-3 can move this loop off DATABASE_URL onto that role without a
-- second migration.
--
-- Reverse:
--   REVOKE UPDATE (attempts, last_error, failed_at, next_attempt_at) ON outbox FROM budget_publisher;
--   DROP INDEX IF EXISTS outbox_claimable;
--   ALTER TABLE outbox DROP COLUMN IF EXISTS next_attempt_at;
--   ALTER TABLE outbox DROP COLUMN IF EXISTS failed_at;
--   ALTER TABLE outbox DROP COLUMN IF EXISTS last_error;
--   ALTER TABLE outbox DROP COLUMN IF EXISTS attempts;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS last_error text NULL;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS failed_at timestamptz NULL;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NULL;

-- Additive: the existing outbox_unpublished index (published_at IS NULL) still serves the
-- not-yet-deployed outbox-publisher's claimOutbox query unchanged. This one is narrower, for the
-- local runner's claim (unpublished, not dead-lettered, past its backoff).
CREATE INDEX IF NOT EXISTS outbox_claimable ON outbox (id) WHERE published_at IS NULL AND failed_at IS NULL;

GRANT UPDATE (attempts, last_error, failed_at, next_attempt_at) ON outbox TO budget_publisher;
