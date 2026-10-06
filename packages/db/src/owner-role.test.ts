import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

/**
 * W0-6 (docs/STACK_AUDIT_2026-10-04.md S-2, S-3, S-21): local and CI used to migrate, seed and
 * test as the Postgres superuser (POSTGRES_USER=budget in docker-compose.yml / the CI service
 * container), which silently bypasses every RLS policy — a superuser bypasses RLS unconditionally,
 * independent of the BYPASSRLS role attribute W2-3 already removed. That let a real gap (W5-3's
 * SECURITY DEFINER RPC tables lacking owner policies) pass every test locally and in CI, and would
 * only have failed in production, where the owner (`budgetos-database-url`) has never been a
 * superuser. scripts/db-init.sql now creates `budget_owner` — NOSUPERUSER NOBYPASSRLS CREATEROLE
 * CREATEDB — as the owner of the `budget` database, and DATABASE_URL (packages/db/.env.example,
 * .github/workflows/ci.yml) points at it instead of the superuser `budget`.
 *
 * This guard makes sure that regression can never creep back in silently: it asserts the role
 * migrations actually run as has neither attribute, for the exact connection `pnpm db:migrate`
 * and every suite uses (DATABASE_URL).
 */

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv(path: string): void {
  if (!existsSync(path)) {
    return;
  }
  const contents = readFileSync(path, "utf8");
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnv(join(packageRoot, ".env"));

const ownerUrl = process.env["DATABASE_URL"] ?? "postgresql://budget_owner:budget_owner@localhost:5432/budget";
const owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
afterAll(() => owner.$disconnect());

describe("the migrating role is not a superuser and does not bypass RLS (W0-6)", () => {
  it("rolsuper = false AND rolbypassrls = false for the DATABASE_URL connection", async () => {
    const [role] = await owner.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(role, "current_user must resolve to a real role").toBeDefined();
    expect(role?.rolsuper, "the migrating role must not be a Postgres superuser").toBe(false);
    expect(role?.rolbypassrls, "the migrating role must not hold BYPASSRLS").toBe(false);
  });

  it("the migrating role can still create and alter roles (CREATEROLE), for migrations that do", async () => {
    const [role] = await owner.$queryRaw<Array<{ rolcreaterole: boolean; rolcreatedb: boolean }>>`
      SELECT rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user`;
    expect(role?.rolcreaterole, "CREATEROLE: 0001_roles and friends CREATE ROLE the login roles; app_lock_placeholder_logins()/bootstrap.ts ALTER them").toBe(true);
    expect(role?.rolcreatedb, "CREATEDB: matches production's owner").toBe(true);
  });
});
