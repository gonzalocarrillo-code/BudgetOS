-- H-011 / H-012 (docs/BUDGET_HISTORY_PLAN.md §2.8, ADR-053): ending a budget and reintroducing it
-- ride on bulk_change like split and merge, so one approval request covers the final version and
-- an optional successor. `payload` carries what applies on approval (the end date and reason).
-- Reverse: ALTER TABLE bulk_change DROP COLUMN payload; restore the kind check to ('edit','split','merge').
ALTER TABLE bulk_change ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}';
ALTER TABLE bulk_change DROP CONSTRAINT IF EXISTS bulk_change_kind_check;
ALTER TABLE bulk_change ADD CONSTRAINT bulk_change_kind_check CHECK (kind IN ('edit', 'split', 'merge', 'end', 'reintroduce'));
CREATE INDEX IF NOT EXISTS envelope_ended_idx ON envelope (workspace_id) WHERE ended_at IS NOT NULL;
