-- EX-9 (ADR-0094, amends ADR-0087): a dimension says where its values come from. `registry` (the
-- default, every dimension so far): hand-managed dimension_value rows. `facts`: the distinct values
-- of `dimension_values ->> key` on live spend_fact / kpi_fact rows of the workspace, read by
-- `listFactDimensionValues` (packages/db/src/fact-dimension-values.ts); the registry refuses to add,
-- edit, merge or retire a value of such a dimension. `campaign` becomes `facts`.
--
-- Expand-only: one new column with a default (old code never reads it) and no row is deleted —
-- existing campaign dimension_value rows (EX-3's demo seed) stay as they are.
--
-- The backfill runs as the migrating role, which has no BYPASSRLS in production while `dimension`
-- is FORCE ROW LEVEL SECURITY (ADR-005, W2-3): without a policy of its own the UPDATE would match
-- nothing there (and everything locally, where the owner is a superuser). A policy bound to
-- CURRENT_USER exists only for the length of this migration.
--
-- Reverse:
--   ALTER TABLE dimension DROP CONSTRAINT IF EXISTS dimension_values_source_check;
--   ALTER TABLE dimension DROP COLUMN IF EXISTS values_source;
ALTER TABLE dimension ADD COLUMN IF NOT EXISTS values_source text NOT NULL DEFAULT 'registry';

DO $$
BEGIN
  ALTER TABLE dimension ADD CONSTRAINT dimension_values_source_check CHECK (values_source IN ('registry', 'facts'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DROP POLICY IF EXISTS ex9_backfill ON dimension;
CREATE POLICY ex9_backfill ON dimension FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);
UPDATE dimension SET values_source = 'facts' WHERE key = 'campaign' AND values_source <> 'facts';
DROP POLICY ex9_backfill ON dimension;
