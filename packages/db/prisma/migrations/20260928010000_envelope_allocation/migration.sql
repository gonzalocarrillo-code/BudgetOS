-- How a child budget follows its parent (product feedback 5, ADR-039): a share of the parent's
-- amount (`percent`, updated when the parent changes in the family editor) or its own amount
-- (`manual`, flagged when the children do not add up). One current rule per child; a change
-- supersedes the old row, which is kept (rules are rows, never edited in place).
--
-- Reverse: DROP TABLE envelope_allocation;
CREATE TABLE IF NOT EXISTS envelope_allocation (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  parent_envelope_id uuid NOT NULL,
  child_envelope_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('percent', 'manual')),
  -- percent of the parent, 0–100, six decimals; NULL for manual
  pct numeric(9,6) NULL CHECK ((mode = 'percent') = (pct IS NOT NULL) AND (pct IS NULL OR (pct >= 0 AND pct <= 100))),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS envelope_allocation_current ON envelope_allocation (child_envelope_id) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS envelope_allocation_parent ON envelope_allocation (parent_envelope_id) WHERE superseded_at IS NULL;
DO $$ BEGIN
  ALTER TABLE envelope_allocation ADD CONSTRAINT envelope_allocation_parent_fkey FOREIGN KEY (parent_envelope_id) REFERENCES envelope (id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE envelope_allocation ADD CONSTRAINT envelope_allocation_child_fkey FOREIGN KEY (child_envelope_id) REFERENCES envelope (id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE envelope_allocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE envelope_allocation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON envelope_allocation;
CREATE POLICY tenant_isolation ON envelope_allocation
  USING (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]))
  WITH CHECK (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]));
GRANT SELECT ON envelope_allocation TO budget_mcp;
