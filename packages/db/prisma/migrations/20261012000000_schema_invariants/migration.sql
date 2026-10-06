-- W3-11 (audit I-32, I-34, I-35, I-37, I-38; plan docs/STACK_HARDENING_PLAN.md). Database-enforced
-- invariants the application already assumes but Postgres never checked: foreign keys on every
-- tenant table's workspace_id and on the pointer columns I-32 names, CHECKs for date order,
-- currency shape and the text status enums (I-34), two NOT NULL fixes (I-35), DEFAULT partitions on
-- the fact/audit tables (I-37), and the missing hot-path indexes (I-38).
--
-- Expand-only, safe against a running production on the previous code:
--   * Every FK and CHECK is added NOT VALID then VALIDATE CONSTRAINT in the same migration, so the
--     ADD itself takes only a brief catalog lock and the validation scan does not block writers.
--   * NOT NULL on outbox.workspace_id and the four array columns goes through the same NOT VALID
--     CHECK -> VALIDATE -> SET NOT NULL -> DROP CHECK dance (the Postgres-documented way to add
--     NOT NULL without a full-table ACCESS EXCLUSIVE scan) instead of a plain ALTER COLUMN.
--   * No column or table the previous code reads is dropped or renamed.
--
-- Skipped deliberately (see the PR): FKs from created_by/owner_id/actor_id columns (~30 of them)
-- to app_user(id). The brief allows skipping where production data might not satisfy a new FK;
-- this environment has no way to check production, only the golden-seeded local database (which
-- is clean for all of them). Flagged as follow-up work rather than guessed at here.
--
-- Reverse (expand-only; a contract migration would need its own PR per AGENTS.md):
--   DROP INDEX IF EXISTS notification_user_read, subscription_entity, comment_live_thread,
--     pacing_rule_live_ws, approval_decision_request_decider;
--   ALTER TABLE spend_fact DROP CONSTRAINT IF EXISTS spend_fact_workspace_id_fkey; (repeat per table/column below)
--   DROP TABLE IF EXISTS spend_fact_default, kpi_fact_default, projection_fact_default, audit_event_default;
--   ALTER TABLE outbox ALTER COLUMN workspace_id DROP NOT NULL;
--   ALTER TABLE dimension ALTER COLUMN allowed_parents DROP NOT NULL, ALTER COLUMN allowed_parents DROP DEFAULT;
--   (same for dimension_value.aliases, hierarchy_template.path, value_constraint.allowed_value_codes)
--   ALTER TABLE envelope DROP CONSTRAINT envelope_parent_id_fkey;
--   ALTER TABLE envelope ADD CONSTRAINT envelope_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES envelope(id) ON DELETE SET NULL ON UPDATE CASCADE;
--   (drop every other CHECK/FK added below by name)

-- =========================================================================================
-- 1. DEFAULT partitions (I-37): a write for a date outside every explicit month partition used
--    to fail with "no partition of relation found for row". ensure_fact_partitions (migrate time,
--    pacing, ingest) keeps creating explicit month partitions ahead of writes; this is the safety
--    net for when that falls behind. Same REVOKE-from-budget_app treatment as every other partition
--    (20260924080000): only the parent is RLS-protected, so a direct SELECT/INSERT on the default
--    partition must be refused the same way (the guard test rls.org-admin.test.ts checks this for
--    every partition of these four parents, default or not).
-- =========================================================================================
CREATE TABLE IF NOT EXISTS spend_fact_default PARTITION OF spend_fact DEFAULT;
CREATE TABLE IF NOT EXISTS kpi_fact_default PARTITION OF kpi_fact DEFAULT;
CREATE TABLE IF NOT EXISTS projection_fact_default PARTITION OF projection_fact DEFAULT;
CREATE TABLE IF NOT EXISTS audit_event_default PARTITION OF audit_event DEFAULT;

REVOKE ALL ON spend_fact_default, kpi_fact_default, projection_fact_default, audit_event_default FROM budget_app, PUBLIC;

-- =========================================================================================
-- 2. Array columns (I-35): nullable with no default, although the application always writes '{}'
--    for "none". A NULL here reads the same as empty to every query that already guards with
--    coalesce(), but a few raw SQL sites do not, so the gap stays live. Fixed in place: backfill,
--    attach the default, then NOT NULL via a pre-validated CHECK so the final ALTER is instant.
-- =========================================================================================
UPDATE dimension SET allowed_parents = '{}' WHERE allowed_parents IS NULL;
ALTER TABLE dimension ALTER COLUMN allowed_parents SET DEFAULT '{}';
ALTER TABLE dimension ADD CONSTRAINT dimension_allowed_parents_not_null CHECK (allowed_parents IS NOT NULL) NOT VALID;
ALTER TABLE dimension VALIDATE CONSTRAINT dimension_allowed_parents_not_null;
ALTER TABLE dimension ALTER COLUMN allowed_parents SET NOT NULL;
ALTER TABLE dimension DROP CONSTRAINT dimension_allowed_parents_not_null;

UPDATE dimension_value SET aliases = '{}' WHERE aliases IS NULL;
ALTER TABLE dimension_value ALTER COLUMN aliases SET DEFAULT '{}';
ALTER TABLE dimension_value ADD CONSTRAINT dimension_value_aliases_not_null CHECK (aliases IS NOT NULL) NOT VALID;
ALTER TABLE dimension_value VALIDATE CONSTRAINT dimension_value_aliases_not_null;
ALTER TABLE dimension_value ALTER COLUMN aliases SET NOT NULL;
ALTER TABLE dimension_value DROP CONSTRAINT dimension_value_aliases_not_null;

UPDATE hierarchy_template SET path = '{}' WHERE path IS NULL;
ALTER TABLE hierarchy_template ALTER COLUMN path SET DEFAULT '{}';
ALTER TABLE hierarchy_template ADD CONSTRAINT hierarchy_template_path_not_null CHECK (path IS NOT NULL) NOT VALID;
ALTER TABLE hierarchy_template VALIDATE CONSTRAINT hierarchy_template_path_not_null;
ALTER TABLE hierarchy_template ALTER COLUMN path SET NOT NULL;
ALTER TABLE hierarchy_template DROP CONSTRAINT hierarchy_template_path_not_null;

UPDATE value_constraint SET allowed_value_codes = '{}' WHERE allowed_value_codes IS NULL;
ALTER TABLE value_constraint ALTER COLUMN allowed_value_codes SET DEFAULT '{}';
ALTER TABLE value_constraint ADD CONSTRAINT value_constraint_allowed_value_codes_not_null CHECK (allowed_value_codes IS NOT NULL) NOT VALID;
ALTER TABLE value_constraint VALIDATE CONSTRAINT value_constraint_allowed_value_codes_not_null;
ALTER TABLE value_constraint ALTER COLUMN allowed_value_codes SET NOT NULL;
ALTER TABLE value_constraint DROP CONSTRAINT value_constraint_allowed_value_codes_not_null;

-- =========================================================================================
-- 3. outbox.workspace_id NOT NULL (I-35): a NULL row can never be published (toMessage() throws,
--    ADR-010); the publisher's claim query already filters `workspace_id = ANY($1)` so a NULL row
--    would sit unclaimed forever anyway. Same pre-validated-CHECK pattern (outbox is the hottest
--    table here).
-- =========================================================================================
ALTER TABLE outbox ADD CONSTRAINT outbox_workspace_id_not_null CHECK (workspace_id IS NOT NULL) NOT VALID;
ALTER TABLE outbox VALIDATE CONSTRAINT outbox_workspace_id_not_null;
ALTER TABLE outbox ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE outbox DROP CONSTRAINT outbox_workspace_id_not_null;

-- =========================================================================================
-- 4. CHECKs (I-34)
-- =========================================================================================

-- Date order: experiment and manual_entry_batch already have this; envelope, fiscal_period and
-- target do not.
ALTER TABLE envelope ADD CONSTRAINT envelope_date_order_check CHECK (end_date >= start_date) NOT VALID;
ALTER TABLE envelope VALIDATE CONSTRAINT envelope_date_order_check;
ALTER TABLE fiscal_period ADD CONSTRAINT fiscal_period_date_order_check CHECK (end_date >= start_date) NOT VALID;
ALTER TABLE fiscal_period VALIDATE CONSTRAINT fiscal_period_date_order_check;
ALTER TABLE target ADD CONSTRAINT target_date_order_check CHECK (end_date >= start_date) NOT VALID;
ALTER TABLE target VALIDATE CONSTRAINT target_date_order_check;

-- Currency shape: every CHAR(3) currency column in the schema (grep '"currency"\|char(3)' across
-- the migrations). target_version.currency is nullable (a target can be unitless).
ALTER TABLE workspace ADD CONSTRAINT workspace_reporting_currency_check CHECK (reporting_currency ~ '^[A-Z]{3}$') NOT VALID;
ALTER TABLE workspace VALIDATE CONSTRAINT workspace_reporting_currency_check;
ALTER TABLE envelope ADD CONSTRAINT envelope_currency_check CHECK (currency ~ '^[A-Z]{3}$') NOT VALID;
ALTER TABLE envelope VALIDATE CONSTRAINT envelope_currency_check;
ALTER TABLE fx_rate ADD CONSTRAINT fx_rate_base_check CHECK (base ~ '^[A-Z]{3}$') NOT VALID;
ALTER TABLE fx_rate VALIDATE CONSTRAINT fx_rate_base_check;
ALTER TABLE fx_rate ADD CONSTRAINT fx_rate_quote_check CHECK (quote ~ '^[A-Z]{3}$') NOT VALID;
ALTER TABLE fx_rate VALIDATE CONSTRAINT fx_rate_quote_check;
ALTER TABLE target_version ADD CONSTRAINT target_version_currency_check CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$') NOT VALID;
ALTER TABLE target_version VALIDATE CONSTRAINT target_version_currency_check;
ALTER TABLE spend_fact ADD CONSTRAINT spend_fact_currency_check CHECK (currency ~ '^[A-Z]{3}$') NOT VALID;
ALTER TABLE spend_fact VALIDATE CONSTRAINT spend_fact_currency_check;
ALTER TABLE budget_baseline_row ADD CONSTRAINT budget_baseline_row_currency_check CHECK (currency ~ '^[A-Z]{3}$') NOT VALID;
ALTER TABLE budget_baseline_row VALIDATE CONSTRAINT budget_baseline_row_currency_check;

-- Text status enums (export_job, naming_template, experiment, manual_entry_batch, bulk_change
-- already have theirs). Value sets read from the code paths that write them (apps/api, apps/workers)
-- and the @budget/domain zod enums where one exists, not from stale comments in schema.prisma:
--   * period_closure.status: closing | closed | failed | restated (close-period.ts, fail-closure.ts,
--     restate.ts; W3-1 added 'closing'/'failed' to the original 'closed'/'restated').
--   * ingest_run.status: queued | running | ok | failed (pipeline.ts, worker.ts).
--   * target.status: only ever 'active' is written anywhere in the codebase (create-target.ts,
--     target-writer.ts); nothing sets it to anything else. Assumption: CHECK restricted to that one
--     value for now; widen it in the same PR that introduces a second status.
--   * thread.status: open | resolved (threads/commands/threads.ts).
--   * saved_view.visibility: @budget/domain SavedViewVisibility = z.enum(["private","workspace"])
--     covers POST /saved-views (apps/api/src/modules/views); a third value, 'shared', is written
--     only by workspaces.ts when a workspace is created from a template (home.test.ts asserts it) —
--     schema.prisma's stale comment ("private | shared | workspace_default") predates the simpler
--     two-value user-facing enum but 'shared' itself is still live. 'workspace_default' is not: grep
--     finds no writer anywhere, so it is left out.
--   * approval_decision.decision: @budget/domain's DecideInput enum (approve | reject |
--     request_changes) plus 'external_evidence', written only by external-evidence.ts.
--   * role_assignment.principal_type: @budget/domain access.ts z.enum(["user","group"]).
--   * envelope_lineage.kind: move | split | merge | continues (structure.ts, end-reintroduce.ts via
--     get-envelope.ts's 'continues' lookups). 'end' never writes lineage (it only sets envelope.ended_*).
ALTER TABLE period_closure ADD CONSTRAINT period_closure_status_check CHECK (status IN ('closing', 'closed', 'failed', 'restated')) NOT VALID;
ALTER TABLE period_closure VALIDATE CONSTRAINT period_closure_status_check;
ALTER TABLE ingest_run ADD CONSTRAINT ingest_run_status_check CHECK (status IN ('queued', 'running', 'ok', 'failed')) NOT VALID;
ALTER TABLE ingest_run VALIDATE CONSTRAINT ingest_run_status_check;
ALTER TABLE target ADD CONSTRAINT target_status_check CHECK (status IN ('active')) NOT VALID;
ALTER TABLE target VALIDATE CONSTRAINT target_status_check;
ALTER TABLE thread ADD CONSTRAINT thread_status_check CHECK (status IN ('open', 'resolved')) NOT VALID;
ALTER TABLE thread VALIDATE CONSTRAINT thread_status_check;
ALTER TABLE saved_view ADD CONSTRAINT saved_view_visibility_check CHECK (visibility IN ('private', 'workspace', 'shared')) NOT VALID;
ALTER TABLE saved_view VALIDATE CONSTRAINT saved_view_visibility_check;
ALTER TABLE approval_decision ADD CONSTRAINT approval_decision_decision_check CHECK (decision IN ('approve', 'reject', 'request_changes', 'external_evidence')) NOT VALID;
ALTER TABLE approval_decision VALIDATE CONSTRAINT approval_decision_decision_check;
ALTER TABLE role_assignment ADD CONSTRAINT role_assignment_principal_type_check CHECK (principal_type IN ('user', 'group')) NOT VALID;
ALTER TABLE role_assignment VALIDATE CONSTRAINT role_assignment_principal_type_check;
ALTER TABLE envelope_lineage ADD CONSTRAINT envelope_lineage_kind_check CHECK (kind IN ('move', 'split', 'merge', 'continues')) NOT VALID;
ALTER TABLE envelope_lineage VALIDATE CONSTRAINT envelope_lineage_kind_check;

-- =========================================================================================
-- 5. Foreign keys (I-32)
-- =========================================================================================

-- 5a. workspace_id -> workspace(id) on every tenant table. RESTRICT everywhere except the two
-- ephemeral caches (rollup_cache, search_document — rebuilt from source data, so losing them on a
-- (never-issued, workspace rows are tombstoned not dropped — ADR-052) workspace delete is fine).
-- Constraint names follow Prisma's own <table>_<column>_fkey convention so the Prisma-modeled
-- tables below need no `map:` override.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- Prisma-modeled tables
    'role_assignment', 'dimension', 'hierarchy_template', 'fiscal_period', 'envelope',
    'envelope_lineage', 'target', 'approval_policy', 'approval_request', 'pacing_rule', 'alert',
    'thread', 'tag', 'taggable', 'saved_view', 'period_closure', 'data_source', 'export_job',
    'comment_reaction', 'naming_template', 'experiment', 'experiment_envelope',
    'manual_entry_batch', 'manual_entry_fact', 'tour', 'envelope_allocation', 'budget_baseline',
    'mapping_profile', 'mapping_synonym', 'metric_definition',
    -- SQL-only tables (no Prisma model), excluding the four partitioned fact/audit tables, which
    -- PostgreSQL 16 does not allow a NOT VALID foreign key on (see below for those).
    'outbox', 'subscription', 'notification', 'bulk_change', 'spend_month', 'search_term', 'slack_message'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE RESTRICT NOT VALID', t, t || '_workspace_id_fkey');
    EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', t, t || '_workspace_id_fkey');
  END LOOP;
END $$;

-- spend_fact, kpi_fact, projection_fact, audit_event: PostgreSQL 16 refuses "ADD CONSTRAINT ...
-- NOT VALID" for a foreign key whose *referencing* table is partitioned ("not yet supported on
-- partitioned tables" — lifted in PG17, not available here; spec §2 pins postgres:16). Adding a
-- validated FK at the parent level instead would take a ShareRowExclusiveLock across the whole
-- scan of every partition, blocking writers — exactly the long lock this migration exists to avoid.
-- Workaround: add the FK to each *partition* individually (an ordinary table, NOT VALID works fine
-- there) and VALIDATE it there (SHARE UPDATE EXCLUSIVE, doesn't block writers); ensure_fact_partitions
-- is updated below to add the same FK, validated, to every partition it creates from now on — for a
-- brand-new empty partition that validation is instant, so no NOT VALID is needed there either. The
-- four parent (partitioned) tables themselves end up with no FK of their own — PostgreSQL has no
-- parent-level constraint to attach without a full scan — but every partition, present and future,
-- carries and enforces it, which is the actual invariant a write ever needs to satisfy.
DO $$
DECLARE parent text; part text;
BEGIN
  FOREACH parent IN ARRAY ARRAY['spend_fact', 'kpi_fact', 'projection_fact', 'audit_event'] LOOP
    FOR part IN
      SELECT c.relname FROM pg_class c
        JOIN pg_inherits i ON i.inhrelid = c.oid
        JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = parent
    LOOP
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE RESTRICT NOT VALID', part, part || '_workspace_id_fkey');
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', part, part || '_workspace_id_fkey');
    END LOOP;
  END LOOP;
END $$;

-- Every partition ensure_fact_partitions creates from now on gets the same FK, instantly valid
-- because the partition is empty at creation. Same SECURITY DEFINER body as 20260924100000
-- (fact_partitions_lock) plus one new EXECUTE.
CREATE OR REPLACE FUNCTION ensure_fact_partitions(from_month date, months_ahead int) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE m date; t text; p text; BEGIN
  IF months_ahead < 0 OR months_ahead > 36 THEN RAISE EXCEPTION 'months_ahead must be 0..36, got %', months_ahead; END IF;
  IF from_month < DATE '2000-01-01' OR from_month > DATE '2100-01-01' THEN RAISE EXCEPTION 'from_month out of range: %', from_month; END IF;
  FOR i IN 0..months_ahead LOOP
    m := (date_trunc('month', from_month) + (i || ' month')::interval)::date;
    FOREACH t IN ARRAY ARRAY['spend_fact','kpi_fact','projection_fact','audit_event'] LOOP
      p := format('%s_%s', t, to_char(m, 'YYYYMM'));
      CONTINUE WHEN to_regclass(format('public.%I', p)) IS NOT NULL;
      -- Only creators serialise; the lock is released at commit.
      EXECUTE format('LOCK TABLE %I IN SHARE UPDATE EXCLUSIVE MODE', t);
      CONTINUE WHEN to_regclass(format('public.%I', p)) IS NOT NULL; -- created while we waited
      EXECUTE format('CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)', p, t, m, (m + interval '1 month')::date);
      EXECUTE format('REVOKE ALL ON %I FROM budget_app, PUBLIC', p);
      -- W3-11 (audit I-32): the new partition is empty, so a validated (non-NOT VALID) add is instant.
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE RESTRICT', p, p || '_workspace_id_fkey');
    END LOOP;
  END LOOP; END $$;

REVOKE ALL ON FUNCTION ensure_fact_partitions(date, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_fact_partitions(date, int) TO budget_app;

-- rollup_cache and search_document: rebuilt from source data, not referenced by anything else, so a
-- (hypothetical — workspaces are never hard-deleted today, ADR-052) workspace delete may cascade here.
ALTER TABLE rollup_cache ADD CONSTRAINT rollup_cache_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE CASCADE NOT VALID;
ALTER TABLE rollup_cache VALIDATE CONSTRAINT rollup_cache_workspace_id_fkey;
ALTER TABLE search_document ADD CONSTRAINT search_document_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE CASCADE NOT VALID;
ALTER TABLE search_document VALIDATE CONSTRAINT search_document_workspace_id_fkey;

-- budget_baseline_row.workspace_id is intentionally not given its own direct FK here: D-013
-- (migration 20261006000000_snapshot_tenant_keys) already ties it to workspace transitively through
-- its composite FKs to budget_baseline(id, workspace_id) and envelope(id, workspace_id), both of
-- which now resolve to a workspace(id)-checked row via budget_baseline's own new FK above.

-- 5b. The specific pointer columns I-32 names.

-- envelope.parent_id: was ON DELETE SET NULL (silently reparents children to the root on a hard
-- delete of the parent); should be RESTRICT. The workspace purge nulls every envelope's parent_id
-- before deleting the rows (see apps/workers/src/purge/purge.ts), so a whole-workspace purge is
-- unaffected; an app code path that tries to delete a single envelope with children still fails loudly,
-- which is the point.
ALTER TABLE envelope DROP CONSTRAINT envelope_parent_id_fkey;
ALTER TABLE envelope ADD CONSTRAINT envelope_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES envelope (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE envelope VALIDATE CONSTRAINT envelope_parent_id_fkey;

-- envelope.current_version_id / draft_version_id -> envelope_version(id): DEFERRABLE INITIALLY
-- DEFERRED because envelope_version.envelope_id -> envelope(id) already exists (0001_tables) and a
-- version row names its envelope before the envelope ever points back at it.
ALTER TABLE envelope ADD CONSTRAINT envelope_current_version_id_fkey FOREIGN KEY (current_version_id) REFERENCES envelope_version (id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED NOT VALID;
ALTER TABLE envelope VALIDATE CONSTRAINT envelope_current_version_id_fkey;
ALTER TABLE envelope ADD CONSTRAINT envelope_draft_version_id_fkey FOREIGN KEY (draft_version_id) REFERENCES envelope_version (id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED NOT VALID;
ALTER TABLE envelope VALIDATE CONSTRAINT envelope_draft_version_id_fkey;

-- envelope_dimension.dimension_id / value_id.
ALTER TABLE envelope_dimension ADD CONSTRAINT envelope_dimension_dimension_id_fkey FOREIGN KEY (dimension_id) REFERENCES dimension (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE envelope_dimension VALIDATE CONSTRAINT envelope_dimension_dimension_id_fkey;
ALTER TABLE envelope_dimension ADD CONSTRAINT envelope_dimension_value_id_fkey FOREIGN KEY (value_id) REFERENCES dimension_value (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE envelope_dimension VALIDATE CONSTRAINT envelope_dimension_value_id_fkey;

-- target.envelope_id (nullable: scope_type = 'filter' has none) and target.current_version_id /
-- draft_version_id -> target_version(id). The brief names envelope_id/current_version_id; this
-- migration also adds draft_version_id for the same reason the envelope side needs both — leaving
-- it out would be the identical unenforced pointer under a different name. Not DEFERRABLE: unlike
-- envelope, target-writer.ts always creates the target row with both pointers NULL and sets them in
-- a later UPDATE once the version exists, so there is no same-transaction forward reference to defer.
ALTER TABLE target ADD CONSTRAINT target_envelope_id_fkey FOREIGN KEY (envelope_id) REFERENCES envelope (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE target VALIDATE CONSTRAINT target_envelope_id_fkey;
ALTER TABLE target ADD CONSTRAINT target_current_version_id_fkey FOREIGN KEY (current_version_id) REFERENCES target_version (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE target VALIDATE CONSTRAINT target_current_version_id_fkey;
ALTER TABLE target ADD CONSTRAINT target_draft_version_id_fkey FOREIGN KEY (draft_version_id) REFERENCES target_version (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE target VALIDATE CONSTRAINT target_draft_version_id_fkey;

-- alert.rule_id / envelope_id.
ALTER TABLE alert ADD CONSTRAINT alert_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES pacing_rule (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE alert VALIDATE CONSTRAINT alert_rule_id_fkey;
ALTER TABLE alert ADD CONSTRAINT alert_envelope_id_fkey FOREIGN KEY (envelope_id) REFERENCES envelope (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE alert VALIDATE CONSTRAINT alert_envelope_id_fkey;

-- period_closure.period_id -> fiscal_period(id).
ALTER TABLE period_closure ADD CONSTRAINT period_closure_period_id_fkey FOREIGN KEY (period_id) REFERENCES fiscal_period (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE period_closure VALIDATE CONSTRAINT period_closure_period_id_fkey;

-- closure_envelope.* (both columns of its composite PK).
ALTER TABLE closure_envelope ADD CONSTRAINT closure_envelope_closure_id_fkey FOREIGN KEY (closure_id) REFERENCES period_closure (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE closure_envelope VALIDATE CONSTRAINT closure_envelope_closure_id_fkey;
ALTER TABLE closure_envelope ADD CONSTRAINT closure_envelope_envelope_id_fkey FOREIGN KEY (envelope_id) REFERENCES envelope (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE closure_envelope VALIDATE CONSTRAINT closure_envelope_envelope_id_fkey;

-- ingest_run.source_id -> data_source(id).
ALTER TABLE ingest_run ADD CONSTRAINT ingest_run_source_id_fkey FOREIGN KEY (source_id) REFERENCES data_source (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE ingest_run VALIDATE CONSTRAINT ingest_run_source_id_fkey;

-- dimension_value.parent_value_id / merged_into_id (self-referencing). The workspace purge nulls
-- both columns for a dimension's values before deleting them (purge.ts), for the same single-
-- statement-self-reference reason as envelope.parent_id above.
ALTER TABLE dimension_value ADD CONSTRAINT dimension_value_parent_value_id_fkey FOREIGN KEY (parent_value_id) REFERENCES dimension_value (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE dimension_value VALIDATE CONSTRAINT dimension_value_parent_value_id_fkey;
ALTER TABLE dimension_value ADD CONSTRAINT dimension_value_merged_into_id_fkey FOREIGN KEY (merged_into_id) REFERENCES dimension_value (id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE dimension_value VALIDATE CONSTRAINT dimension_value_merged_into_id_fkey;

-- =========================================================================================
-- 6. Indexes (I-38). CONCURRENTLY cannot run inside Prisma's migration transaction; plain CREATE
--    INDEX IF NOT EXISTS takes a brief ACCESS EXCLUSIVE lock, acceptable here because every one of
--    these tables is small (notification, subscription, comment, pacing_rule, approval_decision are
--    all low-thousands of rows even in the largest workspace today).
-- =========================================================================================
CREATE INDEX IF NOT EXISTS notification_user_read ON notification (user_id, read_at);
CREATE INDEX IF NOT EXISTS subscription_entity ON subscription (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS comment_live_thread ON comment (thread_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS pacing_rule_live_ws ON pacing_rule (workspace_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS approval_decision_request_decider ON approval_decision (request_id, decided_by);
