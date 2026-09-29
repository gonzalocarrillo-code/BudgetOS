-- Phase E (ADR-053, docs/BUDGET_HISTORY_PLAN.md): snapshots saved by hand, and ending budgets.
--
-- budget_baseline      a named moment: the workspace, a filter's budgets, or one budget's subtree.
-- budget_baseline_row  one row per live budget in scope at capture, with what an as-of query
--                      cannot rebuild (parent, granularities, name, dates). Written once.
-- envelope.ended_*     a budget stopped early (§2.8); status stays APPROVED, so the planner,
--                      roll-ups and pacing are unchanged. Lineage kind 'continues' links a successor.
--
-- Reverse: DROP TABLE budget_baseline_row; DROP TABLE budget_baseline;
--          ALTER TABLE envelope DROP COLUMN ended_at, DROP COLUMN ended_by, DROP COLUMN ended_reason;
CREATE TABLE IF NOT EXISTS budget_baseline (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('plan', 'close', 'other')),
  scope jsonb NOT NULL DEFAULT '{}',
  period_key text NULL,
  as_of timestamptz NOT NULL,
  note text NULL,
  taken_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz NULL,
  row_count integer NOT NULL,
  total_reporting numeric(18,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS budget_baseline_ws ON budget_baseline (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS budget_baseline_row (
  baseline_id uuid NOT NULL REFERENCES budget_baseline (id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL,
  envelope_id uuid NOT NULL,
  version_id uuid NULL,
  amount numeric(18,2) NOT NULL,
  amount_reporting numeric(18,2) NOT NULL,
  currency char(3) NOT NULL,
  parent_id uuid NULL,
  name text NOT NULL,
  dimension_values jsonb NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  is_leaf boolean NOT NULL,
  PRIMARY KEY (baseline_id, envelope_id)
);
CREATE INDEX IF NOT EXISTS budget_baseline_row_envelope ON budget_baseline_row (workspace_id, envelope_id);

ALTER TABLE budget_baseline ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_baseline FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON budget_baseline;
CREATE POLICY tenant_isolation ON budget_baseline
  USING (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]))
  WITH CHECK (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]));
ALTER TABLE budget_baseline_row ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_baseline_row FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON budget_baseline_row;
CREATE POLICY tenant_isolation ON budget_baseline_row
  USING (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]))
  WITH CHECK (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]));
GRANT SELECT ON budget_baseline, budget_baseline_row TO budget_mcp;

ALTER TABLE envelope ADD COLUMN IF NOT EXISTS ended_at timestamptz NULL;
ALTER TABLE envelope ADD COLUMN IF NOT EXISTS ended_by uuid NULL;
ALTER TABLE envelope ADD COLUMN IF NOT EXISTS ended_reason text NULL;
