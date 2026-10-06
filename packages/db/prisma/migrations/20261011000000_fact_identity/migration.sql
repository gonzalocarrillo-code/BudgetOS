-- ADR-071 (audit T-1, T-2): fact identity and reconciliation. EXPAND step only.
--
-- * natural_key (spend_fact, kpi_fact): the fact's identity, sha256 of the source id and the
--   source's row_id, or of its business key (date, dimension tuple, match key, metric, occurrence).
--   Never the measure. Facts loaded before this migration keep NULL: a full-extract source has no
--   key to rebuild, so its next run supersedes them and reloads (which is correct).
-- * superseded_at / superseded_by_run_id (all three fact tables): a fact a later run no longer
--   delivered, or a warehouse row that moved to another date. Kept for history (facts are never
--   hard-deleted), read by nothing: the planner, spend_month, roll-ups, retention, exports and the
--   unmatched queue all filter `superseded_at IS NULL`.
-- * spend_month_apply() counts only live facts: an UPDATE that sets superseded_at subtracts like a
--   DELETE, one that clears it adds like an INSERT.
--
-- The previous worker keeps working against this schema: it writes source_row_hash (whose unique
-- constraint stays) and leaves the new columns NULL. The new worker writes natural_key and the same
-- value into source_row_hash, so both unique indexes agree on its rows.
--
-- CONTRACT (a later PR, once no deployed worker writes facts without natural_key):
--   ALTER TABLE spend_fact DROP CONSTRAINT IF EXISTS spend_fact_workspace_id_source_row_hash_period_date_key;
--   ALTER TABLE kpi_fact DROP CONSTRAINT IF EXISTS kpi_fact_workspace_id_source_row_hash_period_date_key;
--
-- Reverse:
--   DROP INDEX IF EXISTS spend_fact_natural_key, kpi_fact_natural_key, spend_fact_live_date, kpi_fact_live_date, projection_fact_live_date;
--   ALTER TABLE spend_fact DROP COLUMN natural_key, DROP COLUMN superseded_at, DROP COLUMN superseded_by_run_id;
--   ALTER TABLE kpi_fact DROP COLUMN natural_key, DROP COLUMN superseded_at, DROP COLUMN superseded_by_run_id;
--   ALTER TABLE projection_fact DROP COLUMN superseded_at, DROP COLUMN superseded_by_run_id;
--   and restore spend_month_apply() from 20260928020000_spend_month_delete (then recompute spend_month as in 20260928000000_spend_month).

-- Nullable columns without a default: a catalog change on the partitioned parents, no rewrite.
ALTER TABLE spend_fact ADD COLUMN IF NOT EXISTS natural_key text NULL;
ALTER TABLE spend_fact ADD COLUMN IF NOT EXISTS superseded_at timestamptz NULL;
ALTER TABLE spend_fact ADD COLUMN IF NOT EXISTS superseded_by_run_id uuid NULL;
ALTER TABLE kpi_fact ADD COLUMN IF NOT EXISTS natural_key text NULL;
ALTER TABLE kpi_fact ADD COLUMN IF NOT EXISTS superseded_at timestamptz NULL;
ALTER TABLE kpi_fact ADD COLUMN IF NOT EXISTS superseded_by_run_id uuid NULL;
ALTER TABLE projection_fact ADD COLUMN IF NOT EXISTS superseded_at timestamptz NULL;
ALTER TABLE projection_fact ADD COLUMN IF NOT EXISTS superseded_by_run_id uuid NULL;

-- The upsert's conflict target. Partial: legacy facts (NULL) are left out. Includes the partition key.
CREATE UNIQUE INDEX IF NOT EXISTS spend_fact_natural_key ON spend_fact (workspace_id, natural_key, period_date) WHERE natural_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS kpi_fact_natural_key ON kpi_fact (workspace_id, natural_key, period_date) WHERE natural_key IS NOT NULL;

-- Reconciliation reads a source's live facts over a date range; no existing index serves that.
CREATE INDEX IF NOT EXISTS spend_fact_live_date ON spend_fact (workspace_id, period_date) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS kpi_fact_live_date ON kpi_fact (workspace_id, period_date) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS projection_fact_live_date ON projection_fact (workspace_id, period_date) WHERE superseded_at IS NULL;

CREATE OR REPLACE FUNCTION spend_month_apply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    INSERT INTO spend_month AS s (workspace_id, envelope_id, month, amount_reporting, fact_count)
      SELECT workspace_id, envelope_id, date_trunc('month', period_date)::date, -sum(amount_reporting), -count(*)
      FROM spend_old WHERE envelope_id IS NOT NULL AND superseded_at IS NULL GROUP BY 1, 2, 3
    ON CONFLICT (workspace_id, envelope_id, month) DO UPDATE
      SET amount_reporting = s.amount_reporting + EXCLUDED.amount_reporting, fact_count = s.fact_count + EXCLUDED.fact_count;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    INSERT INTO spend_month AS s (workspace_id, envelope_id, month, amount_reporting, fact_count)
      SELECT workspace_id, envelope_id, date_trunc('month', period_date)::date, sum(amount_reporting), count(*)
      FROM spend_new WHERE envelope_id IS NOT NULL AND superseded_at IS NULL GROUP BY 1, 2, 3
    ON CONFLICT (workspace_id, envelope_id, month) DO UPDATE
      SET amount_reporting = s.amount_reporting + EXCLUDED.amount_reporting, fact_count = s.fact_count + EXCLUDED.fact_count;
  END IF;
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    DELETE FROM spend_month WHERE fact_count = 0 AND workspace_id IN (SELECT DISTINCT workspace_id FROM spend_old);
  END IF;
  RETURN NULL;
END $$;
