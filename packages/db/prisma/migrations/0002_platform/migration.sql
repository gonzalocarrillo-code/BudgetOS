-- ===== Facts (partitioned; not Prisma models) =====
CREATE TABLE IF NOT EXISTS spend_fact (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  envelope_id uuid NULL,
  dimension_values jsonb NOT NULL,
  period_date date NOT NULL,
  currency char(3) NOT NULL,
  amount numeric(18,2) NOT NULL,
  amount_reporting numeric(18,2) NOT NULL,
  fx_rate_id uuid NULL,
  source_system text NOT NULL,
  source_run_id uuid NOT NULL,
  source_row_hash text NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, period_date),
  UNIQUE (workspace_id, source_row_hash, period_date)
) PARTITION BY RANGE (period_date);

CREATE TABLE IF NOT EXISTS kpi_fact (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  envelope_id uuid NULL,
  dimension_values jsonb NOT NULL,
  period_date date NOT NULL,
  metric text NOT NULL,                    -- conversions | revenue | impressions | clicks | leads | <custom>
  value numeric(18,4) NOT NULL,
  attribution_model text NULL,
  source_system text NOT NULL,
  source_run_id uuid NOT NULL,
  source_row_hash text NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, period_date),
  UNIQUE (workspace_id, source_row_hash, period_date)
) PARTITION BY RANGE (period_date);

CREATE TABLE IF NOT EXISTS projection_fact (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  envelope_id uuid NULL,
  dimension_values jsonb NOT NULL,
  period_date date NOT NULL,               -- the date the projection is FOR
  metric text NOT NULL DEFAULT 'spend',
  value numeric(18,4) NOT NULL,
  value_reporting numeric(18,4) NULL,
  formula_version text NOT NULL,
  horizon_end date NOT NULL,
  source_system text NOT NULL,
  source_run_id uuid NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, period_date)
) PARTITION BY RANGE (period_date);

-- Partition maintenance: create month partitions 3 months ahead. Called by pacing job daily.
CREATE OR REPLACE FUNCTION ensure_fact_partitions(from_month date, months_ahead int) RETURNS void LANGUAGE plpgsql AS $$
DECLARE m date; t text; BEGIN
  FOR i IN 0..months_ahead LOOP
    m := (date_trunc('month', from_month) + (i || ' month')::interval)::date;
    FOREACH t IN ARRAY ARRAY['spend_fact','kpi_fact','projection_fact','audit_event'] LOOP
      EXECUTE format('CREATE TABLE IF NOT EXISTS %I_%s PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
        t, to_char(m,'YYYYMM'), t, m, (m + interval '1 month')::date);
    END LOOP;
  END LOOP; END $$;

CREATE INDEX IF NOT EXISTS spend_fact_env_date ON spend_fact (workspace_id, envelope_id, period_date);
CREATE INDEX IF NOT EXISTS spend_fact_unmatched ON spend_fact (workspace_id, period_date) WHERE envelope_id IS NULL;
CREATE INDEX IF NOT EXISTS spend_fact_dims ON spend_fact USING gin (dimension_values);
CREATE INDEX IF NOT EXISTS kpi_fact_env_date ON kpi_fact (workspace_id, envelope_id, metric, period_date);
CREATE INDEX IF NOT EXISTS projection_fact_env_date ON projection_fact (workspace_id, envelope_id, metric, period_date);

-- ===== Audit (partitioned by month on occurred_at) =====
CREATE TABLE IF NOT EXISTS audit_event (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NULL,
  actor_id uuid NULL,
  actor_type text NOT NULL,                -- user | system | mcp
  action text NOT NULL,                    -- envelope.version.created, approval.decided, ...
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  before jsonb NULL,
  after jsonb NULL,
  reason text NULL,
  request_id text NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX IF NOT EXISTS audit_entity ON audit_event (entity_type, entity_id, occurred_at);
CREATE INDEX IF NOT EXISTS audit_ws_time ON audit_event (workspace_id, occurred_at);
-- append-only
CREATE OR REPLACE FUNCTION audit_no_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit_event is append-only'; END $$;
DROP TRIGGER IF EXISTS audit_event_immutable ON audit_event;
CREATE TRIGGER audit_event_immutable BEFORE UPDATE OR DELETE ON audit_event FOR EACH ROW EXECUTE FUNCTION audit_no_update();

-- ===== Transactional outbox =====
CREATE TABLE IF NOT EXISTS outbox (
  id bigserial PRIMARY KEY,
  workspace_id uuid NULL,
  topic text NOT NULL,                     -- budget.changed | target.changed | facts.loaded | registry.changed | thread.changed | tag.changed | approval.changed | alert.triggered
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz NULL
);
CREATE INDEX IF NOT EXISTS outbox_unpublished ON outbox (id) WHERE published_at IS NULL;

-- ===== Roll-up cache (§5.3) =====
CREATE TABLE IF NOT EXISTS rollup_cache (
  workspace_id uuid NOT NULL,
  template_id uuid NOT NULL,
  node_path text NOT NULL,                 -- 'nordwind/latam/br/meta'
  envelope_id uuid NULL,                   -- the envelope this node is (if it exists as one)
  period_start date NOT NULL,
  period_end date NOT NULL,
  measures jsonb NOT NULL,                 -- { budget, actual, projected, leafCount, pendingCount, openAlerts, openThreads }
  data_version bigint NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, template_id, node_path, period_start, period_end)
);

-- ===== Search index (§11.3) =====
-- array_to_string(anyarray, text) is STABLE in Postgres 16, so a generated tsvector cannot call it.
-- text[] concatenation does not depend on session state; the wrapper is declared IMMUTABLE.
CREATE OR REPLACE FUNCTION immutable_array_to_string(tags text[], sep text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT array_to_string(tags, sep) $$;

CREATE TABLE IF NOT EXISTS search_document (
  workspace_id uuid NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  title text NOT NULL,
  path text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  tags text[] NOT NULL DEFAULT '{}',
  dimension_values jsonb NOT NULL DEFAULT '{}',
  numeric_facets jsonb NOT NULL DEFAULT '{}',     -- { budget, actual, cpa, pace_index }
  owner_id uuid NULL,
  status text NULL,
  period_key text NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple'::regconfig, coalesce(title,'')), 'A') ||
    setweight(to_tsvector('simple'::regconfig, coalesce(path,'')), 'B') ||
    setweight(to_tsvector('simple'::regconfig, coalesce(immutable_array_to_string(tags, ' '),'')), 'B') ||
    setweight(to_tsvector('simple'::regconfig, coalesce(body,'')), 'C')
  ) STORED,
  trigram text GENERATED ALWAYS AS (lower(coalesce(title,'') || ' ' || coalesce(path,''))) STORED,
  PRIMARY KEY (workspace_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS search_tsv ON search_document USING gin (tsv);
CREATE INDEX IF NOT EXISTS search_trgm ON search_document USING gin (trigram gin_trgm_ops);
CREATE INDEX IF NOT EXISTS search_dims ON search_document USING gin (dimension_values);
CREATE INDEX IF NOT EXISTS search_type_time ON search_document (workspace_id, entity_type, updated_at DESC);

-- ===== ltree path maintenance for dimension_value =====
CREATE OR REPLACE FUNCTION dimension_value_set_path() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_path ltree; BEGIN
  IF NEW.parent_value_id IS NULL THEN
    NEW.path := text2ltree(regexp_replace(lower(NEW.code), '[^a-z0-9_]', '_', 'g'));
  ELSE
    SELECT path INTO parent_path FROM dimension_value WHERE id = NEW.parent_value_id;
    NEW.path := parent_path || text2ltree(regexp_replace(lower(NEW.code), '[^a-z0-9_]', '_', 'g'));
  END IF;
  RETURN NEW; END $$;
DROP TRIGGER IF EXISTS dimension_value_path ON dimension_value;
CREATE TRIGGER dimension_value_path BEFORE INSERT OR UPDATE OF code, parent_value_id ON dimension_value FOR EACH ROW EXECUTE FUNCTION dimension_value_set_path();
CREATE INDEX IF NOT EXISTS dimension_value_path_gist ON dimension_value USING gist (path);

-- ===== RLS =====
-- Helper: current tenant / user from session settings (set by withTenant)
CREATE OR REPLACE FUNCTION app_workspace_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.workspace_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_is_org_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.is_org_admin', true), 'false')::boolean $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'envelope','envelope_lineage','target','approval_policy','approval_request','pacing_rule','alert',
    'thread','tag','taggable','saved_view','period_closure','data_source','hierarchy_template','fiscal_period',
    'spend_fact','kpi_fact','projection_fact','rollup_cache','search_document','outbox'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (app_is_org_admin() OR workspace_id = app_workspace_id()) WITH CHECK (app_is_org_admin() OR workspace_id = app_workspace_id())', t);
  END LOOP; END $$;

-- Child tables inherit tenancy through their parent (envelope_version, envelope_phasing, envelope_dimension, target_version, approval_decision, comment, rule_state)
ALTER TABLE envelope_version ENABLE ROW LEVEL SECURITY; ALTER TABLE envelope_version FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON envelope_version;
CREATE POLICY tenant_isolation ON envelope_version USING (EXISTS (SELECT 1 FROM envelope e WHERE e.id = envelope_id)) WITH CHECK (EXISTS (SELECT 1 FROM envelope e WHERE e.id = envelope_id));
ALTER TABLE envelope_dimension ENABLE ROW LEVEL SECURITY; ALTER TABLE envelope_dimension FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON envelope_dimension;
CREATE POLICY tenant_isolation ON envelope_dimension USING (EXISTS (SELECT 1 FROM envelope e WHERE e.id = envelope_id)) WITH CHECK (EXISTS (SELECT 1 FROM envelope e WHERE e.id = envelope_id));
ALTER TABLE target_version ENABLE ROW LEVEL SECURITY; ALTER TABLE target_version FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON target_version;
CREATE POLICY tenant_isolation ON target_version USING (EXISTS (SELECT 1 FROM target t WHERE t.id = target_id)) WITH CHECK (EXISTS (SELECT 1 FROM target t WHERE t.id = target_id));
ALTER TABLE approval_decision ENABLE ROW LEVEL SECURITY; ALTER TABLE approval_decision FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON approval_decision;
CREATE POLICY tenant_isolation ON approval_decision USING (EXISTS (SELECT 1 FROM approval_request r WHERE r.id = request_id)) WITH CHECK (EXISTS (SELECT 1 FROM approval_request r WHERE r.id = request_id));
ALTER TABLE comment ENABLE ROW LEVEL SECURITY; ALTER TABLE comment FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON comment;
CREATE POLICY tenant_isolation ON comment USING (EXISTS (SELECT 1 FROM thread t WHERE t.id = thread_id)) WITH CHECK (EXISTS (SELECT 1 FROM thread t WHERE t.id = thread_id));

-- audit_event: readable within tenant, insert-only
ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY; ALTER TABLE audit_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_read ON audit_event; DROP POLICY IF EXISTS audit_insert ON audit_event;
CREATE POLICY audit_read ON audit_event FOR SELECT USING (app_is_org_admin() OR workspace_id = app_workspace_id());
CREATE POLICY audit_insert ON audit_event FOR INSERT WITH CHECK (true);

-- Org-wide registry rows (workspace_id NULL) are readable by everyone in the org; workspace rows by their tenant.
ALTER TABLE dimension ENABLE ROW LEVEL SECURITY; ALTER TABLE dimension FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS registry_read ON dimension;
CREATE POLICY registry_read ON dimension USING (workspace_id IS NULL OR workspace_id = app_workspace_id() OR app_is_org_admin())
  WITH CHECK (workspace_id = app_workspace_id() OR app_is_org_admin());

-- Guard: an approved child sum may not exceed the parent's approved amount (belt and braces; the service checks first).
CREATE OR REPLACE FUNCTION check_parent_cap() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_amt numeric(18,2); child_sum numeric(18,2); parent_env uuid; allow boolean; BEGIN
  IF NEW.status <> 'APPROVED' THEN RETURN NEW; END IF;
  SELECT e.parent_id INTO parent_env FROM envelope e WHERE e.id = NEW.envelope_id;
  IF parent_env IS NULL THEN RETURN NEW; END IF;
  SELECT p.allow_over_allocation, v.amount_reporting INTO allow, parent_amt
    FROM envelope p LEFT JOIN envelope_version v ON v.id = p.current_version_id WHERE p.id = parent_env;
  IF allow OR parent_amt IS NULL THEN RETURN NEW; END IF;
  SELECT coalesce(sum(cv.amount_reporting),0) INTO child_sum
    FROM envelope c JOIN envelope_version cv ON cv.id = c.current_version_id
    WHERE c.parent_id = parent_env AND c.id <> NEW.envelope_id;
  IF child_sum + NEW.amount_reporting > parent_amt THEN
    RAISE EXCEPTION 'CAP_EXCEEDED: children % + % > parent %', child_sum, NEW.amount_reporting, parent_amt USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW; END $$;
DROP TRIGGER IF EXISTS envelope_version_cap ON envelope_version;
CREATE TRIGGER envelope_version_cap BEFORE INSERT OR UPDATE OF status ON envelope_version FOR EACH ROW EXECUTE FUNCTION check_parent_cap();

SELECT ensure_fact_partitions(current_date, 6);

-- Spec §3.3 names envelope_phasing and rule_state with the other child tables, but the
-- statements above do not enable RLS on them. Same parent-exists policy as the siblings.
ALTER TABLE envelope_phasing ENABLE ROW LEVEL SECURITY;
ALTER TABLE envelope_phasing FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON envelope_phasing;
CREATE POLICY tenant_isolation ON envelope_phasing
  USING (EXISTS (SELECT 1 FROM envelope_version v WHERE v.id = version_id))
  WITH CHECK (EXISTS (SELECT 1 FROM envelope_version v WHERE v.id = version_id));

ALTER TABLE rule_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE rule_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON rule_state;
CREATE POLICY tenant_isolation ON rule_state
  USING (EXISTS (SELECT 1 FROM pacing_rule p WHERE p.id = rule_id))
  WITH CHECK (EXISTS (SELECT 1 FROM pacing_rule p WHERE p.id = rule_id));
