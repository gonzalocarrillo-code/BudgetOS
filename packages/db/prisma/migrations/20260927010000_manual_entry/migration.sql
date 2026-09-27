-- T-039 (spec §26.1 `0006_manual_entry`, plan §6.1): manual result entry batches and the lineage
-- of the facts an approved batch wrote. Dated like every migration since 0003 so it sorts after
-- the ones already applied.
--
-- Reverse:
--   DROP TABLE manual_entry_fact; DROP TABLE manual_entry_batch; DROP TYPE "ManualEntryStatus";

DO $$ BEGIN
  CREATE TYPE "ManualEntryStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS manual_entry_batch (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  channel text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL CHECK (period_end >= period_start),
  status "ManualEntryStatus" NOT NULL DEFAULT 'DRAFT',
  rows jsonb NOT NULL DEFAULT '[]',
  totals jsonb NOT NULL DEFAULT '{}',
  approval_request_id uuid NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz NULL
);
CREATE INDEX IF NOT EXISTS manual_entry_batch_workspace_id_status_idx ON manual_entry_batch (workspace_id, status);

-- One row per fact an approved batch wrote: who entered it and who approved it (spec §26.2).
CREATE TABLE IF NOT EXISTS manual_entry_fact (
  workspace_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  row_no int NOT NULL,
  fact_table text NOT NULL CHECK (fact_table IN ('spend_fact', 'kpi_fact')),
  metric text NULL,
  source_row_hash text NOT NULL,
  period_date date NOT NULL,
  entered_by uuid NOT NULL,
  approved_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, source_row_hash, period_date)
);
DO $$ BEGIN
  ALTER TABLE manual_entry_fact ADD CONSTRAINT manual_entry_fact_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES manual_entry_batch (id) ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS manual_entry_fact_hash_idx ON manual_entry_fact (workspace_id, source_row_hash, period_date);

ALTER TABLE manual_entry_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE manual_entry_batch FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON manual_entry_batch;
CREATE POLICY tenant_isolation ON manual_entry_batch
  USING (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]))
  WITH CHECK (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]));

ALTER TABLE manual_entry_fact ENABLE ROW LEVEL SECURITY;
ALTER TABLE manual_entry_fact FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON manual_entry_fact;
CREATE POLICY tenant_isolation ON manual_entry_fact
  USING (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]))
  WITH CHECK (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]));

GRANT SELECT ON manual_entry_batch, manual_entry_fact TO budget_mcp;
