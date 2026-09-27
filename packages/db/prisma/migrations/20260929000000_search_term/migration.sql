-- The words of a workspace's search documents (T-034). A misspelled search word is corrected
-- against this small list (pg_trgm similarity, a few thousand rows) instead of rechecking every
-- document that shares a trigram with it. A statement-level trigger on search_document keeps it
-- current for every write path. Words are never removed: a stale word only corrects a search to a
-- word that finds nothing.
CREATE TABLE IF NOT EXISTS search_term (
  workspace_id uuid NOT NULL,
  term         text NOT NULL,
  PRIMARY KEY (workspace_id, term)
);
CREATE INDEX IF NOT EXISTS search_term_trgm ON search_term USING gin (term gin_trgm_ops);
ALTER TABLE search_term ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_term FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON search_term;
CREATE POLICY tenant_isolation ON search_term
  USING (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]))
  WITH CHECK (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]));

-- The words full-text search indexes: title, path, tags and body, lower-cased, 3 to 40 letters or digits.
CREATE OR REPLACE FUNCTION search_term_words(title text, path text, tags text[], body text) RETURNS SETOF text
  LANGUAGE sql IMMUTABLE AS $$
  SELECT DISTINCT w FROM regexp_split_to_table(lower(coalesce(title,'') || ' ' || coalesce(path,'') || ' ' || coalesce(immutable_array_to_string(tags, ' '),'') || ' ' || coalesce(body,'')), '[^[:alnum:]]+') w
  WHERE length(w) BETWEEN 3 AND 40
$$;

CREATE OR REPLACE FUNCTION search_term_apply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO search_term (workspace_id, term)
    SELECT DISTINCT d.workspace_id, w FROM search_new d, search_term_words(d.title, d.path, d.tags, d.body) w
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS search_term_ins ON search_document;
DROP TRIGGER IF EXISTS search_term_upd ON search_document;
CREATE TRIGGER search_term_ins AFTER INSERT ON search_document REFERENCING NEW TABLE AS search_new FOR EACH STATEMENT EXECUTE FUNCTION search_term_apply();
CREATE TRIGGER search_term_upd AFTER UPDATE ON search_document REFERENCING NEW TABLE AS search_new FOR EACH STATEMENT EXECUTE FUNCTION search_term_apply();

-- Backfill from the documents already indexed.
INSERT INTO search_term (workspace_id, term)
  SELECT DISTINCT d.workspace_id, w FROM search_document d, search_term_words(d.title, d.path, d.tags, d.body) w
ON CONFLICT DO NOTHING;
