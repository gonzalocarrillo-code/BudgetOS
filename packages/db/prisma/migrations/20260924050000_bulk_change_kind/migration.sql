-- T-014: split and merge reuse bulk_change (one approval for all versions). kind tells the approval
-- engine what to do at the end: archive_ids are archived once approved (their zero version first);
-- created_ids are archived if the request is rejected or withdrawn (never approved).
-- Reverse: ALTER TABLE bulk_change DROP COLUMN kind, DROP COLUMN archive_ids, DROP COLUMN created_ids;
ALTER TABLE bulk_change ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'edit';
ALTER TABLE bulk_change ADD COLUMN IF NOT EXISTS archive_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE bulk_change ADD COLUMN IF NOT EXISTS created_ids uuid[] NOT NULL DEFAULT '{}';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bulk_change_kind_check') THEN
    ALTER TABLE bulk_change ADD CONSTRAINT bulk_change_kind_check CHECK (kind IN ('edit', 'split', 'merge'));
  END IF;
END $$;
