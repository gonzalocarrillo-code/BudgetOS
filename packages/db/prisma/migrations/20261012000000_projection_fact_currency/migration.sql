-- W4-1 (audit T-4): projection facts carry a currency and, once converted, an FX rate.
-- AGENTS §4: every amount carries currency; a converted amount carries fx_rate_id. projection_fact
-- had neither, so a projection feed in a non-reporting currency was shown unconverted everywhere
-- (projected close, variance, the pacing rules projected_close_pct / projected_variance_abs).
--
-- EXPAND only: two nullable columns, catalog-only on the partitioned parent (no table rewrite), then
-- a backfill of existing rows. Existing rows were always treated as already being in the workspace's
-- reporting currency (the old code copied `value` straight into `value_reporting`), so that is what
-- they are backfilled to; `fx_rate_id` stays NULL for them, exactly like a same-currency spend fact.
-- The previous worker (which never set currency) keeps working: new rows it writes keep currency
-- NULL until it is redeployed, same as any other expand-only column.
--
-- Reverse:
--   ALTER TABLE projection_fact DROP COLUMN currency, DROP COLUMN fx_rate_id;

ALTER TABLE projection_fact ADD COLUMN IF NOT EXISTS currency char(3) NULL;
ALTER TABLE projection_fact ADD COLUMN IF NOT EXISTS fx_rate_id uuid NULL;

-- Backfill: every existing row was stored as a reporting-currency value with no FX conversion.
UPDATE projection_fact pf
SET currency = w.reporting_currency
FROM workspace w
WHERE w.id = pf.workspace_id AND pf.currency IS NULL;
