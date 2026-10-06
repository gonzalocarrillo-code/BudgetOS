-- W3-4 (audit I-9, I-12): ingest_run and export_job gain a lease so a worker that dies mid-run
-- doesn't leave the row `running` forever (docs/runbooks/ingest.md, exports.md). The claim
-- (queued → running) sets lease_until = now() + 20 minutes; the ingest pipeline refreshes
-- lease_until/heartbeat_at after each 5,000-row flush, and the export worker after writing its
-- object. A sweeper pass (apps/workers/src/ingest/sweeper.ts) fails `running` rows whose lease
-- expired, with the same audit_event + outbox a normal failure writes, and re-queues an ingest
-- run once. Expand-only: both columns are nullable and additive, so the previous code (which never
-- reads or writes them) keeps working unmodified against this schema.
--
-- Reverse:
--   DROP INDEX IF EXISTS export_job_running_idx;
--   DROP INDEX IF EXISTS ingest_run_running_idx;
--   ALTER TABLE export_job DROP COLUMN IF EXISTS heartbeat_at;
--   ALTER TABLE export_job DROP COLUMN IF EXISTS lease_until;
--   ALTER TABLE ingest_run DROP COLUMN IF EXISTS heartbeat_at;
--   ALTER TABLE ingest_run DROP COLUMN IF EXISTS lease_until;

ALTER TABLE ingest_run ADD COLUMN IF NOT EXISTS lease_until timestamptz NULL;
ALTER TABLE ingest_run ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz NULL;
ALTER TABLE export_job ADD COLUMN IF NOT EXISTS lease_until timestamptz NULL;
ALTER TABLE export_job ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz NULL;

-- One indexed query finds the stale `running` rows (the sweeper's whole job).
CREATE INDEX IF NOT EXISTS ingest_run_running_idx ON ingest_run (status) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS export_job_running_idx ON export_job (status) WHERE status = 'running';
