-- T-015: a metric's ratio can carry a scale factor (CPM = spend / impressions × 1000). The planner
-- applies it after dividing the sums, so roll-ups stay Σnumerator / Σdenominator × multiplier.
-- Reverse: ALTER TABLE metric_definition DROP COLUMN multiplier;
ALTER TABLE metric_definition ADD COLUMN IF NOT EXISTS multiplier numeric NOT NULL DEFAULT 1;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'metric_definition_multiplier_check') THEN
    ALTER TABLE metric_definition ADD CONSTRAINT metric_definition_multiplier_check CHECK (multiplier > 0);
  END IF;
END $$;
