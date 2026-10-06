-- W0-6 (docs/STACK_AUDIT_2026-10-04.md: S-2, S-3, S-21; docs/STACK_HARDENING_PLAN.md W0-6).
--
-- Local (docker-compose.yml) and CI (.github/workflows/ci.yml) both ran migrations, seed and
-- every test suite as POSTGRES_USER=budget, a Postgres superuser. Production's owner
-- (`budgetos-database-url`) has never been a superuser and has had no BYPASSRLS since W2-3 — so a
-- SECURITY DEFINER function or a migration that only works for a superuser/BYPASSRLS owner passed
-- every test twice (W5-3's RPC tables lacked owner policies; W2-3 itself needed empirical
-- discovery) and would only have failed in production. This script creates a second role,
-- `budget_owner`, with the same restrictions as production's owner, makes it the OWNER of the
-- `budget` database, and pre-creates the extensions 0001_roles installs so that migration's own
-- `CREATE EXTENSION IF NOT EXISTS` statements are no-ops under the non-superuser owner regardless
-- of whether a given extension is "trusted" in this Postgres version.
--
-- `budget` (POSTGRES_USER, still a superuser) continues to exist for `psql`/`docker exec`
-- convenience and for running this script itself; nothing in the repo connects as it anymore.
-- Migrations, seed and every test suite run as `budget_owner` (DATABASE_URL).
--
-- Run as the superuser, BEFORE `pnpm db:migrate`:
--   - docker-compose.yml mounts this file into /docker-entrypoint-initdb.d/, which Postgres's
--     entrypoint runs once, automatically, the first time the data directory is created (an
--     existing local volume must be recreated: `pnpm db:reset`, i.e. `docker compose down -v`).
--   - ci.yml's `test` job runs it by hand with `psql` once the service container is healthy,
--     because GitHub Actions starts service containers before the repo is checked out, so a
--     volume mount of a repo file is not available to them.
--
-- CREATEROLE: 0001_roles, 20260924070000_outbox_publisher_role and 20260925020000_mcp_role all
-- CREATE ROLE the three login roles as the migrating role; 20261010020000_role_placeholder_lock's
-- app_lock_placeholder_logins() and apps/api/src/deploy/bootstrap.ts both ALTER ROLE them
-- (NOLOGIN / LOGIN PASSWORD). CREATEDB: matches production's owner, which can provision
-- additional databases.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'budget_owner') THEN
    CREATE ROLE budget_owner LOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE CREATEDB PASSWORD 'budget_owner';
  END IF;
END
$$;

ALTER DATABASE budget OWNER TO budget_owner;

-- Idempotent no-ops once 0001_roles runs under budget_owner; created here, as the superuser, so
-- that whether or not a given extension is "trusted" (installable by a non-superuser database
-- owner) never matters.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;
