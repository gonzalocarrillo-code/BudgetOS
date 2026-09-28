-- T-040 (spec §27, plan §11.7): guided tours and their completion, workspace templates, and the
-- `demo` flag on every row the demo dataset writes (so one transaction can purge it).
--
-- Reverse:
--   DROP TABLE tour_completion; DROP TABLE tour; DROP TABLE workspace_template;
--   ALTER TABLE envelope DROP COLUMN demo; (same for envelope_version, target, target_version, spend_fact, kpi_fact)

-- tour: workspace_id NULL = the built-in default of a role; a workspace's own rows override it.
CREATE TABLE IF NOT EXISTS tour (
  id uuid PRIMARY KEY,
  workspace_id uuid NULL,
  role text NOT NULL CHECK (role IN ('planner', 'approver', 'finance', 'data_admin')),
  name text NOT NULL,
  steps jsonb NOT NULL,
  version int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tour_workspace_role ON tour (coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), role);

CREATE TABLE IF NOT EXISTS tour_completion (
  user_id uuid NOT NULL,
  tour_id uuid NOT NULL,
  version int NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tour_id, version)
);
DO $$ BEGIN
  ALTER TABLE tour_completion ADD CONSTRAINT tour_completion_tour_id_fkey FOREIGN KEY (tour_id) REFERENCES tour (id) ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- workspace_template: org_id NULL = built in (default_agency, from seed/defaults.*.ts).
CREATE TABLE IF NOT EXISTS workspace_template (
  id uuid PRIMARY KEY,
  org_id uuid NULL,
  key text NOT NULL,
  name text NOT NULL,
  description text NULL,
  registry jsonb NOT NULL DEFAULT '[]',
  hierarchy_templates jsonb NOT NULL DEFAULT '[]',
  policies jsonb NOT NULL DEFAULT '[]',
  rules jsonb NOT NULL DEFAULT '[]',
  saved_views jsonb NOT NULL DEFAULT '[]',
  tours jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_template_key ON workspace_template (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), key);

-- Demo rows (spec §27): set by the demo generator, deleted by the purge.
ALTER TABLE envelope ADD COLUMN IF NOT EXISTS demo boolean NOT NULL DEFAULT false;
ALTER TABLE envelope_version ADD COLUMN IF NOT EXISTS demo boolean NOT NULL DEFAULT false;
ALTER TABLE target ADD COLUMN IF NOT EXISTS demo boolean NOT NULL DEFAULT false;
ALTER TABLE target_version ADD COLUMN IF NOT EXISTS demo boolean NOT NULL DEFAULT false;
ALTER TABLE spend_fact ADD COLUMN IF NOT EXISTS demo boolean NOT NULL DEFAULT false;
ALTER TABLE kpi_fact ADD COLUMN IF NOT EXISTS demo boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS envelope_demo_idx ON envelope (workspace_id) WHERE demo;

-- RLS. tour: read the defaults and the visible workspaces' rows; write a workspace's rows as an
-- org admin (org admins edit tours, spec §27); the defaults are written by the org-admin bypass too.
ALTER TABLE tour ENABLE ROW LEVEL SECURITY;
ALTER TABLE tour FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tour_read ON tour;
DROP POLICY IF EXISTS tour_write ON tour;
CREATE POLICY tour_read ON tour FOR SELECT
  USING (workspace_id IS NULL OR workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]));
CREATE POLICY tour_write ON tour FOR ALL
  USING ((SELECT app_is_org_admin()) AND (workspace_id IS NULL OR workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[])))
  WITH CHECK ((SELECT app_is_org_admin()) AND (workspace_id IS NULL OR workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[])));

-- tour_completion: each user reads and writes only their own.
ALTER TABLE tour_completion ENABLE ROW LEVEL SECURITY;
ALTER TABLE tour_completion FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS own_rows ON tour_completion;
CREATE POLICY own_rows ON tour_completion
  USING (user_id = (SELECT app_user_id()))
  WITH CHECK (user_id = (SELECT app_user_id()));

-- workspace_template: the built-in ones and the org's; the org admin writes.
ALTER TABLE workspace_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_template FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS template_read ON workspace_template;
DROP POLICY IF EXISTS template_write ON workspace_template;
CREATE POLICY template_read ON workspace_template FOR SELECT
  USING (org_id IS NULL OR org_id = (SELECT app_org_id()));
CREATE POLICY template_write ON workspace_template FOR ALL
  USING ((SELECT app_is_org_admin()) AND (org_id IS NULL OR org_id = (SELECT app_org_id())))
  WITH CHECK ((SELECT app_is_org_admin()) AND (org_id IS NULL OR org_id = (SELECT app_org_id())));

GRANT SELECT ON tour, tour_completion, workspace_template TO budget_mcp;
