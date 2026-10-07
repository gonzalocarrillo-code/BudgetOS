-- EX-5 (ADR-0090): campaign → budget mapping from custom rules of three kinds, source-agnostic.
-- naming_convention: a registry row saying how a campaign name is built (delimiter + ordered token
--   positions → dimension keys, optional value aliases per token). At match time a fact's campaign
--   name is parsed into dimension values added to the fact's tuple. Soft-deleted only.
-- spend_fact / kpi_fact / projection_fact.budget_ref: the budget the source row itself names (a
--   column a source mapping declares with role `budget_ref`: a Budget OS budget id, or a budget's
--   match key). New nullable column: the previous code never reads it.
-- match_status gains the reasons a fact stays unassigned ('name_mismatch', 'unknown_budget_ref',
--   'budget_ref_outside_dates'); match_method gains 'reference' and 'naming'. Additive: the previous
--   code only tests match_status = 'ambiguous' and never writes the new values.
-- Reverse:
--   DROP TABLE IF EXISTS naming_convention;
--   UPDATE spend_fact SET match_method = 'tuple' WHERE match_method IN ('reference', 'naming'); (same for kpi_fact, projection_fact)
--   UPDATE spend_fact SET match_status = NULL WHERE match_status <> 'ambiguous'; (same for kpi_fact, projection_fact)
--   ALTER TABLE spend_fact DROP COLUMN budget_ref; (same for kpi_fact, projection_fact)
--   re-add each *_match_status_check as IN ('ambiguous') and *_match_method_check without 'reference', 'naming'.

CREATE TABLE IF NOT EXISTS naming_convention (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  delimiter text NOT NULL,
  tokens jsonb NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz NULL,
  deleted_by uuid NULL,
  CONSTRAINT naming_convention_tokens CHECK (jsonb_typeof(tokens) = 'array' AND jsonb_array_length(tokens) > 0),
  CONSTRAINT naming_convention_delimiter CHECK (length(delimiter) BETWEEN 1 AND 3)
);
CREATE INDEX IF NOT EXISTS naming_convention_live ON naming_convention (workspace_id, created_at) WHERE deleted_at IS NULL;

ALTER TABLE naming_convention ENABLE ROW LEVEL SECURITY;
ALTER TABLE naming_convention FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON naming_convention;
CREATE POLICY tenant_isolation ON naming_convention
  USING (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]))
  WITH CHECK (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]));
GRANT SELECT ON naming_convention TO budget_mcp;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['spend_fact', 'kpi_fact', 'projection_fact'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS budget_ref text NULL', t);
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_match_status_check');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (match_status IN (''ambiguous'', ''name_mismatch'', ''unknown_budget_ref'', ''budget_ref_outside_dates''))', t, t || '_match_status_check');
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_match_method_check');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (match_method IN (''external_id'', ''match_key'', ''tuple'', ''manual'', ''rule'', ''reference'', ''naming''))', t, t || '_match_method_check');
  END LOOP;
END $$;
