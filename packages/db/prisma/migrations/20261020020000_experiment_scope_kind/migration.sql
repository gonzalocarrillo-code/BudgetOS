-- EX-2 (ADR-086): each experiment side records what its filter is evaluated on: 'envelope' (the
-- budgets it selects, spec §25 — the only behaviour before this migration, so the default keeps
-- every existing row and the previous code unchanged) or 'fact' (spend / KPI facts by their own
-- dimension_values, e.g. campaign). Expand-only: two columns with a default, no rename, no drop.
--
-- Reverse:
--   ALTER TABLE experiment DROP CONSTRAINT IF EXISTS experiment_test_scope_kind_check;
--   ALTER TABLE experiment DROP CONSTRAINT IF EXISTS experiment_control_scope_kind_check;
--   ALTER TABLE experiment DROP COLUMN IF EXISTS test_scope_kind, DROP COLUMN IF EXISTS control_scope_kind;

ALTER TABLE experiment ADD COLUMN IF NOT EXISTS test_scope_kind text NOT NULL DEFAULT 'envelope';
ALTER TABLE experiment ADD COLUMN IF NOT EXISTS control_scope_kind text NOT NULL DEFAULT 'envelope';
DO $$ BEGIN
  ALTER TABLE experiment ADD CONSTRAINT experiment_test_scope_kind_check CHECK (test_scope_kind IN ('envelope', 'fact'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE experiment ADD CONSTRAINT experiment_control_scope_kind_check CHECK (control_scope_kind IN ('envelope', 'fact'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
