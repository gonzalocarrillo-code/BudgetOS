-- EX-1 (ADR-0085): one-to-one campaign → budget matching.
-- match_rule: a registry row that sends every fact whose dimension_values satisfy `predicate` (a
--   FilterGroup over fact dimensions, e.g. campaign = X) to one envelope, optionally only inside
--   [start_date, end_date]. Soft-deleted (deleted_at), never hard-deleted.
-- spend_fact / kpi_fact / projection_fact: match_status = 'ambiguous' (with envelope_id NULL) when
--   more than one envelope qualifies at the deciding level; match_candidates lists them. Both are
--   new nullable columns, so the previous code keeps working (it never reads them). match_method
--   gains 'rule'.
-- Reverse:
--   DROP FUNCTION IF EXISTS match_rule_matches(jsonb, jsonb); DROP TABLE IF EXISTS match_rule;
--   UPDATE spend_fact SET match_method = 'tuple' WHERE match_method = 'rule'; (same for kpi_fact, projection_fact)
--   ALTER TABLE spend_fact DROP COLUMN match_status, DROP COLUMN match_candidates; (same for kpi_fact, projection_fact)
--   re-add each *_match_method_check without 'rule'.

CREATE TABLE IF NOT EXISTS match_rule (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  envelope_id uuid NOT NULL REFERENCES envelope (id) ON DELETE RESTRICT,
  predicate jsonb NOT NULL,
  start_date date NULL,
  end_date date NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz NULL,
  deleted_by uuid NULL,
  CONSTRAINT match_rule_dates CHECK (start_date IS NULL OR end_date IS NULL OR start_date <= end_date)
);
CREATE INDEX IF NOT EXISTS match_rule_live ON match_rule (workspace_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS match_rule_envelope ON match_rule (envelope_id);

ALTER TABLE match_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE match_rule FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON match_rule;
CREATE POLICY tenant_isolation ON match_rule
  USING (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]))
  WITH CHECK (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]));
GRANT SELECT ON match_rule TO budget_mcp;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['spend_fact', 'kpi_fact', 'projection_fact'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS match_status text NULL', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS match_candidates uuid[] NULL', t);
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_match_status_check');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (match_status IN (''ambiguous''))', t, t || '_match_status_check');
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_match_method_check');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (match_method IN (''external_id'', ''match_key'', ''tuple'', ''manual'', ''rule''))', t, t || '_match_method_check');
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (workspace_id, period_date) WHERE match_status IS NOT NULL', t || '_ambiguous', t);
  END LOOP;
END $$;

-- A match rule's predicate (the FilterGroup AST of @budget/domain, restricted by MatchRulePredicate
-- to dimension fields and eq / neq / in / nin / contains / starts_with / is_empty / not_empty)
-- evaluated against a fact's dimension_values. One function, so matching is one statement per fact
-- table whatever the number of rules, and no rule is ever compiled into SQL text.
CREATE OR REPLACE FUNCTION match_rule_matches(g jsonb, d jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$
DECLARE
  c jsonb;
  v text;
  want text;
  r boolean;
  is_and boolean;
BEGIN
  IF g ? 'field' THEN
    v := d ->> (g -> 'field' ->> 'key');
    want := g -> 'value' #>> '{}';
    CASE g ->> 'op'
      WHEN 'eq' THEN RETURN v IS NOT NULL AND v = want;
      WHEN 'neq' THEN RETURN v IS NULL OR v <> want;
      WHEN 'in' THEN RETURN v IS NOT NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(g -> 'value') x WHERE x = v);
      WHEN 'nin' THEN RETURN v IS NULL OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(g -> 'value') x WHERE x = v);
      WHEN 'contains' THEN RETURN v IS NOT NULL AND strpos(lower(v), lower(want)) > 0;
      WHEN 'starts_with' THEN RETURN v IS NOT NULL AND left(lower(v), length(want)) = lower(want);
      WHEN 'is_empty' THEN RETURN v IS NULL OR v = '';
      WHEN 'not_empty' THEN RETURN v IS NOT NULL AND v <> '';
      ELSE RAISE EXCEPTION 'match_rule_matches: unsupported op %', g ->> 'op';
    END CASE;
  END IF;
  is_and := coalesce(g ->> 'logic', 'and') = 'and';
  r := is_and;
  FOR c IN SELECT * FROM jsonb_array_elements(coalesce(g -> 'children', '[]'::jsonb)) LOOP
    IF is_and AND NOT match_rule_matches(c, d) THEN r := false; EXIT; END IF;
    IF NOT is_and AND match_rule_matches(c, d) THEN r := true; EXIT; END IF;
  END LOOP;
  IF jsonb_array_length(coalesce(g -> 'children', '[]'::jsonb)) = 0 THEN r := true; END IF;
  IF coalesce((g ->> 'not')::boolean, false) THEN RETURN NOT r; END IF;
  RETURN r;
END
$fn$;
