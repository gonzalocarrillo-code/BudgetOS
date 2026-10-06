-- W1-5 (audit I-5, ADR-0072, decision D-2): bulk-edit and budget-import previews move from
-- per-process memory / optional Redis to Postgres, so any API instance can commit a preview
-- another instance built. Expand-only: the Memory and Redis PreviewStore implementations are
-- untouched (local dev / PREVIEW_STORE=redis parity).
--
-- `budget_app`'s CRUD on this table comes from the `ALTER DEFAULT PRIVILEGES` in 0001_roles; no
-- extra GRANT is needed. `budget_mcp` gets SELECT below (ADR-019's T-025 guard: budget_mcp reads
-- every table budget_app reads, even one apps/mcp itself never queries).
--
-- Reverse: REVOKE SELECT ON bulk_preview FROM budget_mcp; DROP TABLE bulk_preview;
CREATE TABLE IF NOT EXISTS bulk_preview (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  author_id uuid NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS bulk_preview_ws_expires ON bulk_preview (workspace_id, expires_at);

ALTER TABLE bulk_preview ENABLE ROW LEVEL SECURITY;
ALTER TABLE bulk_preview FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON bulk_preview;
CREATE POLICY tenant_isolation ON bulk_preview
  USING (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]))
  WITH CHECK (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]));
GRANT SELECT ON bulk_preview TO budget_mcp;
