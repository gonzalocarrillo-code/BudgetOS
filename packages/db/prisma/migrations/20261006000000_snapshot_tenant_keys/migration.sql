-- D-013 (docs/DATA_PLAN.md §8.2): the database itself refuses a snapshot row whose workspace is not
-- its snapshot's or its budget's. RLS already hides other tenants' rows from every role; these keys
-- make a cross-tenant row impossible to write, whatever the code does.
-- Reverse: drop the three constraints below, and restore budget_baseline_row_baseline_id_fkey.

ALTER TABLE budget_baseline ADD CONSTRAINT budget_baseline_id_workspace_key UNIQUE (id, workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS envelope_id_workspace_key ON envelope (id, workspace_id);
ALTER TABLE envelope ADD CONSTRAINT envelope_id_workspace_key UNIQUE USING INDEX envelope_id_workspace_key;

ALTER TABLE budget_baseline_row DROP CONSTRAINT IF EXISTS budget_baseline_row_baseline_id_fkey;
ALTER TABLE budget_baseline_row
  ADD CONSTRAINT budget_baseline_row_baseline_tenant_fkey FOREIGN KEY (baseline_id, workspace_id) REFERENCES budget_baseline (id, workspace_id) ON DELETE RESTRICT;
ALTER TABLE budget_baseline_row
  ADD CONSTRAINT budget_baseline_row_envelope_tenant_fkey FOREIGN KEY (envelope_id, workspace_id) REFERENCES envelope (id, workspace_id) ON DELETE RESTRICT;
