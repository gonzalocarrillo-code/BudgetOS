-- D-004 / D-005 (docs/DATA_PLAN.md §2.3): mapping profiles and synonyms.
-- mapping_profile: a named, saved column mapping a workspace reuses across sources and uploads; a
--   source that points at one takes its mapping from it, and a change to the profile reaches them.
-- mapping_synonym: the workspace's own words for columns and metrics (tcpa = cpa), on top of the
--   built-in list; `learned` rows come from every mapping a person saves.
-- Reverse: ALTER TABLE data_source DROP COLUMN mapping_profile_id; DROP TABLE mapping_synonym, mapping_profile;
CREATE TABLE IF NOT EXISTS mapping_profile (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('spend', 'kpi', 'spend+kpi', 'projection')),
  mapping jsonb NOT NULL,
  parse_pattern text NULL,
  header text[] NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz NULL,
  UNIQUE (workspace_id, name)
);

ALTER TABLE data_source ADD COLUMN IF NOT EXISTS mapping_profile_id uuid NULL REFERENCES mapping_profile (id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS data_source_profile ON data_source (mapping_profile_id) WHERE mapping_profile_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS mapping_synonym (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('column', 'metric')),
  -- lower case, accents and punctuation stripped (the guesser's own normal form)
  term text NOT NULL,
  target jsonb NOT NULL,
  origin text NOT NULL CHECK (origin IN ('learned', 'manual')),
  uses integer NOT NULL DEFAULT 1,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, kind, term)
);

ALTER TABLE mapping_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE mapping_profile FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mapping_profile;
CREATE POLICY tenant_isolation ON mapping_profile
  USING (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]))
  WITH CHECK (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]));
ALTER TABLE mapping_synonym ENABLE ROW LEVEL SECURITY;
ALTER TABLE mapping_synonym FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mapping_synonym;
CREATE POLICY tenant_isolation ON mapping_synonym
  USING (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]))
  WITH CHECK (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]));
GRANT SELECT ON mapping_profile, mapping_synonym TO budget_mcp;
