-- Pacing rules can be deleted (product feedback 2026-09-28: rules 100% editable). A deleted rule
-- is kept for its alerts' history and audit trail; lists and the pacing worker skip it.
ALTER TABLE pacing_rule ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
