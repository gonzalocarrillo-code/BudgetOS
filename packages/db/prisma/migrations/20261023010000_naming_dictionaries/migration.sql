-- EX-7 (ADR-0093): campaign-naming dictionaries are data, per workspace and granularity.
-- naming_dictionary: one row per (workspace, granularity key) once its dictionary is used: the
--   built-in kind it was seeded from (null: none), when the built-in entries were copied, and an
--   optional external source it is linked to (EX-8 will sync a Sheet / Snowflake into it).
-- naming_dictionary_entry: code as written in campaign names (matched case-, accent- and
--   punctuation-insensitively through code_norm) → the registry value it means (`value`, created on
--   demand), its meaning (`label`) and notes. source: builtin (seeded from @budget/domain's
--   naming-dictionaries.ts), user, ai (accepted AI proposals), sync (EX-8, read-only in the editor).
--   Edits soft-delete the old row and insert a new one; never hard-deleted. One live row per code.
-- New tables only: the previous code never reads them. EX-6's per-position aliases stay in
-- naming_convention.tokens and are still read; the application copies them into entries on the
-- next dictionary or convention write (a data migration here would run under FORCE RLS as the
-- non-BYPASSRLS owner in production and see no rows).
-- Reverse:
--   DROP TABLE IF EXISTS naming_dictionary_entry; DROP TABLE IF EXISTS naming_dictionary;

CREATE TABLE IF NOT EXISTS naming_dictionary (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  dimension_key text NOT NULL,
  builtin_kind text NULL,
  seeded_at timestamptz NULL,
  sync_source_id uuid NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT naming_dictionary_key CHECK (dimension_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  CONSTRAINT naming_dictionary_unique UNIQUE (workspace_id, dimension_key)
);

CREATE TABLE IF NOT EXISTS naming_dictionary_entry (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace (id) ON DELETE RESTRICT,
  dimension_key text NOT NULL,
  code text NOT NULL,
  code_norm text NOT NULL,
  value text NOT NULL,
  label text NOT NULL,
  notes text NULL,
  source text NOT NULL,
  sync_source_id uuid NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz NULL,
  deleted_by uuid NULL,
  CONSTRAINT naming_dictionary_entry_source CHECK (source IN ('builtin', 'user', 'ai', 'sync')),
  CONSTRAINT naming_dictionary_entry_code CHECK (length(code) BETWEEN 1 AND 200 AND length(code_norm) BETWEEN 1 AND 200),
  CONSTRAINT naming_dictionary_entry_value CHECK (length(value) BETWEEN 1 AND 200 AND length(label) BETWEEN 1 AND 200)
);
CREATE UNIQUE INDEX IF NOT EXISTS naming_dictionary_entry_live ON naming_dictionary_entry (workspace_id, dimension_key, code_norm) WHERE deleted_at IS NULL;

ALTER TABLE naming_dictionary ENABLE ROW LEVEL SECURITY;
ALTER TABLE naming_dictionary FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON naming_dictionary;
CREATE POLICY tenant_isolation ON naming_dictionary
  USING (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]))
  WITH CHECK (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]));
GRANT SELECT ON naming_dictionary TO budget_mcp;

ALTER TABLE naming_dictionary_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE naming_dictionary_entry FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON naming_dictionary_entry;
CREATE POLICY tenant_isolation ON naming_dictionary_entry
  USING (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]))
  WITH CHECK (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]));
GRANT SELECT ON naming_dictionary_entry TO budget_mcp;
