-- S-9 (docs/STACK_AUDIT_2026-10-04.md): the three login roles created by 0001_roles,
-- 20260924070000_outbox_publisher_role and 20260925020000_mcp_role all carry the literal
-- password 'replace-in-secret-manager' until apps/api/src/deploy/bootstrap.ts rotates it.
-- Postgres cannot read a role's password back, so app_role_state tracks, per role, whether it
-- is still on that placeholder.
--
-- app_lock_placeholder_logins() sets NOLOGIN on any role app_role_state still marks as a
-- placeholder. This migration only DEFINES the function; it never calls it. The rule for when
-- it runs: ONLY when NODE_ENV=production, or whenever bootstrap.ts otherwise runs by hand — never
-- automatically from a migration. Local development and CI apply this migration and keep using
-- the placeholder password straight away (packages/db/.env.example, .github/workflows/ci.yml);
-- nothing here changes that, because nothing here calls the function. See
-- docs/runbooks/deploy.md ("Roles and passwords") for the full rule and apps/api/src/deploy/
-- bootstrap.ts, which is the only caller: it locks placeholder logins first, then rotates each
-- role's password, re-enables LOGIN and marks app_role_state.placeholder = false.
--
-- app_role_state is cluster-wide infra state, not tenant data (no workspace_id, like
-- "organization" and the role-grant tables already in this schema), so it carries no RLS policy;
-- EXECUTE on the function is revoked from PUBLIC so only the owner role (the one migrations and
-- bootstrap run as) can invoke it.
--
-- 0001_roles' ALTER DEFAULT PRIVILEGES grants budget_app SELECT/INSERT/UPDATE/DELETE on every
-- new table as it's created, so app_role_state needs an explicit REVOKE: it is owner-only
-- bookkeeping, not something budget_app, budget_publisher or budget_mcp ever reads or writes
-- (apps/mcp/src/readonly.test.ts, T-025, checks budget_mcp reads everything budget_app reads —
-- the fix is to grant neither, not to add budget_mcp to the exception).
--
-- Reverse: REVOKE ALL ON FUNCTION app_lock_placeholder_logins() FROM PUBLIC (no-op, kept for
--          symmetry); DROP FUNCTION IF EXISTS app_lock_placeholder_logins();
--          DROP TABLE IF EXISTS app_role_state;
CREATE TABLE IF NOT EXISTS app_role_state (
  role_name text PRIMARY KEY,
  placeholder boolean NOT NULL DEFAULT true,
  rotated_at timestamptz
);

REVOKE ALL ON app_role_state FROM budget_app, budget_publisher, budget_mcp;

INSERT INTO app_role_state (role_name)
VALUES ('budget_app'), ('budget_publisher'), ('budget_mcp')
ON CONFLICT (role_name) DO NOTHING;

CREATE OR REPLACE FUNCTION app_lock_placeholder_logins() RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT role_name FROM app_role_state WHERE placeholder LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = r.role_name) THEN
      EXECUTE format('ALTER ROLE %I NOLOGIN', r.role_name);
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION app_lock_placeholder_logins() FROM PUBLIC;
