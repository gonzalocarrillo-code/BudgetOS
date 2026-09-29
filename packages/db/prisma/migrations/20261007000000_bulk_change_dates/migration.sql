-- R9-002 (ADR-060): a date change to an approved budget is one bulk change under one approval, like
-- an early end: its re-phased versions and the dates of the budget and the children it trims.
-- Reverse: restore the kind check to ('edit','split','merge','end','reintroduce','import').
ALTER TABLE bulk_change DROP CONSTRAINT IF EXISTS bulk_change_kind_check;
ALTER TABLE bulk_change ADD CONSTRAINT bulk_change_kind_check CHECK (kind IN ('edit', 'split', 'merge', 'end', 'reintroduce', 'import', 'dates'));
