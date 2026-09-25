-- T-023 exports (plan §6.2, spec §17 `exports`, ADR-017). One row per export job: the query it
-- runs (with the requester's read scope already ANDed into the filter), its state, and the object
-- the export-worker wrote. Workspace-scoped like every tenant table; jobs are kept (no hard delete).
--
-- Reverse: DROP TABLE export_job;
CREATE TABLE IF NOT EXISTS "export_job" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "query" JSONB NOT NULL,
    "filename" TEXT NOT NULL,
    "object_uri" TEXT,
    "row_count" INTEGER,
    "error" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "export_job_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "export_job_kind_check" CHECK ("kind" IN ('csv', 'xlsx', 'sheets')),
    CONSTRAINT "export_job_status_check" CHECK ("status" IN ('queued', 'running', 'done', 'failed'))
);

CREATE INDEX IF NOT EXISTS "export_job_workspace_id_created_by_created_at_idx" ON "export_job"("workspace_id", "created_by", "created_at");

ALTER TABLE export_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_job FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON export_job;
CREATE POLICY tenant_isolation ON export_job
  USING (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]))
  WITH CHECK (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]));
