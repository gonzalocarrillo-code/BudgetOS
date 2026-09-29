-- D-008 (docs/DATA_PLAN.md §3): a budget import is one bulk change under one approval, like a
-- paste or a split: its new budgets, the parents it creates and its changes are approved together.
-- Reverse: restore the kind check to ('edit','split','merge','end','reintroduce').
ALTER TABLE bulk_change DROP CONSTRAINT IF EXISTS bulk_change_kind_check;
ALTER TABLE bulk_change ADD CONSTRAINT bulk_change_kind_check CHECK (kind IN ('edit', 'split', 'merge', 'end', 'reintroduce', 'import'));
