-- T-024 closures (spec §15, plan §4.5, ADR-018).
-- 1. closure_envelope: the envelopes a closure locked and the status each had before. A restatement
--    restores that status unless another closed closure still covers the envelope. It follows its
--    parent period_closure for RLS, like the other child tables (20260924010000).
-- 2. At most one closed (not restated) closure per period, enforced by the database so two
--    Finance users closing at once cannot both succeed.
--
-- Reverse: DROP TABLE closure_envelope; DROP INDEX period_closure_one_closed;
CREATE TABLE IF NOT EXISTS "closure_envelope" (
    "closure_id" UUID NOT NULL,
    "envelope_id" UUID NOT NULL,
    "prior_status" "EnvelopeStatus" NOT NULL,

    CONSTRAINT "closure_envelope_pkey" PRIMARY KEY ("closure_id","envelope_id")
);

CREATE INDEX IF NOT EXISTS "closure_envelope_envelope_id_idx" ON "closure_envelope"("envelope_id");

ALTER TABLE closure_envelope ENABLE ROW LEVEL SECURITY;
ALTER TABLE closure_envelope FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON closure_envelope;
CREATE POLICY tenant_isolation ON closure_envelope
  USING (closure_id = ANY (ARRAY(SELECT c.id FROM period_closure c)))
  WITH CHECK (closure_id = ANY (ARRAY(SELECT c.id FROM period_closure c)));

CREATE UNIQUE INDEX IF NOT EXISTS period_closure_one_closed ON period_closure (workspace_id, period_id) WHERE status = 'closed';
