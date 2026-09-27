-- T-038 (spec §25.1 `0005_experiments`, plan §4.12): experiments and the envelopes linked to them.
-- Dated like every migration since 0003 so it sorts after the ones already applied. experiment_envelope
-- carries workspace_id (AGENTS §4: every tenant table has it and an RLS policy); spec §25.1 omits it.
--
-- Reverse:
--   DROP TABLE experiment_envelope; DROP TABLE experiment;
--   DROP TYPE "ExperimentRole"; DROP TYPE "ExperimentStatus"; DROP TYPE "ExperimentKind";

DO $$ BEGIN
  CREATE TYPE "ExperimentKind" AS ENUM ('PLATFORM_TEST', 'OBJECTIVE_TEST', 'AUDIENCE_TEST', 'CREATIVE_TEST', 'GEO_HOLDOUT', 'CUSTOM');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "ExperimentStatus" AS ENUM ('PLANNED', 'RUNNING', 'EVALUATING', 'CONCLUDED', 'ABANDONED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "ExperimentRole" AS ENUM ('TEST', 'CONTROL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS experiment (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  name text NOT NULL,
  hypothesis text NOT NULL,
  kind "ExperimentKind" NOT NULL,
  test_scope_filter jsonb NOT NULL,
  control_scope_filter jsonb NULL,
  primary_metric_key text NOT NULL,
  success_criterion jsonb NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL CHECK (end_date >= start_date),
  status "ExperimentStatus" NOT NULL DEFAULT 'PLANNED',
  owner_id uuid NOT NULL,
  decision text NULL,
  decided_by uuid NULL,
  decided_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS experiment_workspace_id_status_idx ON experiment (workspace_id, status);

CREATE TABLE IF NOT EXISTS experiment_envelope (
  experiment_id uuid NOT NULL,
  envelope_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  role "ExperimentRole" NOT NULL,
  PRIMARY KEY (experiment_id, envelope_id)
);
DO $$ BEGIN
  ALTER TABLE experiment_envelope ADD CONSTRAINT experiment_envelope_experiment_id_fkey FOREIGN KEY (experiment_id) REFERENCES experiment (id) ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS experiment_envelope_envelope_idx ON experiment_envelope (envelope_id);

ALTER TABLE experiment ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiment FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON experiment;
CREATE POLICY tenant_isolation ON experiment
  USING (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]))
  WITH CHECK (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]));

ALTER TABLE experiment_envelope ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiment_envelope FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON experiment_envelope;
CREATE POLICY tenant_isolation ON experiment_envelope
  USING (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]))
  WITH CHECK (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]));

GRANT SELECT ON experiment, experiment_envelope TO budget_mcp;
