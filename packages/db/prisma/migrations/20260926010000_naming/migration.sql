-- T-036 (spec §24.1 `0004_naming`, plan §4.10): naming templates, envelope display names and match
-- keys, how each fact was matched, and a source's optional parse pattern. The folder is dated like
-- every migration since 0003 so it sorts after the ones already applied; its content is §24.1's.
--
-- Reverse:
--   DROP TABLE naming_template;
--   ALTER TABLE envelope DROP COLUMN display_name, DROP COLUMN match_key;
--   ALTER TABLE spend_fact DROP COLUMN match_method; ALTER TABLE kpi_fact DROP COLUMN match_method;
--   ALTER TABLE projection_fact DROP COLUMN match_method; ALTER TABLE data_source DROP COLUMN parse_pattern;

CREATE TABLE IF NOT EXISTS naming_template (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('display', 'match_key')),
  chips jsonb NOT NULL,
  casing text NOT NULL DEFAULT 'original' CHECK (casing IN ('original', 'lower', 'upper')),
  whitespace text NOT NULL DEFAULT 'keep' CHECK (whitespace IN ('keep', 'underscore', 'dash', 'remove')),
  strip_accents boolean NOT NULL DEFAULT false,
  version int NOT NULL DEFAULT 1,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- One active template per kind per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS naming_template_active ON naming_template (workspace_id, kind) WHERE is_active;

ALTER TABLE naming_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE naming_template FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON naming_template;
CREATE POLICY tenant_isolation ON naming_template
  USING (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]))
  WITH CHECK (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]));
GRANT SELECT ON naming_template TO budget_mcp;

ALTER TABLE envelope ADD COLUMN IF NOT EXISTS display_name text, ADD COLUMN IF NOT EXISTS match_key text;
CREATE INDEX IF NOT EXISTS envelope_match_key_idx ON envelope (workspace_id, match_key);

-- Set on every matched fact (spec §24.3); the ingest normalizer writes a provisional external_id or
-- match_key, the tuple match confirms it (or writes tuple), and an unmatched fact keeps NULL.
ALTER TABLE spend_fact ADD COLUMN IF NOT EXISTS match_method text CHECK (match_method IN ('external_id', 'match_key', 'tuple', 'manual'));
ALTER TABLE kpi_fact ADD COLUMN IF NOT EXISTS match_method text CHECK (match_method IN ('external_id', 'match_key', 'tuple', 'manual'));
ALTER TABLE projection_fact ADD COLUMN IF NOT EXISTS match_method text CHECK (match_method IN ('external_id', 'match_key', 'tuple', 'manual'));

-- Optional regex with named groups, e.g. (?<country>[A-Z]{2})_(?<platform>\w+), applied to the column mapped as match_key.
ALTER TABLE data_source ADD COLUMN IF NOT EXISTS parse_pattern text;
