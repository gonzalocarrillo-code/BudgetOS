import "../test-support/harness.js"; // side effect: loads packages/db/.env
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDeploySecrets, bootstrap, checkSecretsStatus } from "./bootstrap.js";

/**
 * W2-3 (audit S-2, S-3, S-21): bootstrap() no longer grants itself BYPASSRLS (permanently or
 * otherwise) to write the organization/app_user/role_assignment rows that have no tenant context
 * yet. Migration 20261010050000_owner_bootstrap_policies instead binds a narrow, explicit, three-
 * table policy to the literal role that ran the migration, via `TO CURRENT_USER`.
 *
 * The shared local Postgres's owner role (`budget`, DATABASE_URL) is itself a real superuser —
 * docker-compose's own doing, nothing to do with bootstrap.ts — so running bootstrap() against it
 * proves nothing about whether the owner *needs* bypass: a superuser bypasses RLS regardless of
 * `rolbypassrls`. This file instead builds its own throwaway, non-superuser, NOBYPASSRLS role,
 * re-creates the one migration's policies bound to that role's literal name (exactly as the real
 * migration binds them to whatever role runs it), and runs bootstrap() through a client connected
 * as that role — the same shape Cloud SQL's non-superuser owner is in production. Everything this
 * role needs beyond the policies (ordinary table GRANTs; `budget` owns these tables, this role does
 * not) is granted explicitly in beforeAll and dropped again in afterAll, never touching the shared
 * `budget`/`budget_app`/`budget_publisher`/`budget_mcp` roles other sessions on this host rely on.
 */

const ownerUrl = (role: string, password: string) => {
  const base = new URL(process.env["DATABASE_URL"] ?? "");
  base.username = role;
  base.password = password;
  return base.toString();
};

const roleName = `w23_boot_${randomBytes(4).toString("hex")}`;
const rolePassword = randomBytes(12).toString("hex");
const admin = new PrismaClient({ datasources: { db: { url: process.env["DATABASE_URL"] ?? "" } } });
const asThrowawayOwner = new PrismaClient({ datasources: { db: { url: ownerUrl(roleName, rolePassword) } } });

const PLACEHOLDER = "replace-in-secret-manager"; // the password every shared login role already has (migrations' own placeholder); never changed here

beforeAll(async () => {
  // A non-superuser, NOBYPASSRLS role with exactly what bootstrap.ts needs beyond the
  // owner_bootstrap policies: ordinary GRANTs (table ownership stays with `budget`) and, for the
  // password-rotation loop, ADMIN OPTION on the three login roles it rotates (the same thing
  // Cloud SQL's elevated owner already holds over them).
  await admin.$executeRawUnsafe(`CREATE ROLE ${roleName} LOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE PASSWORD '${rolePassword}'`);
  for (const r of ["budget_app", "budget_publisher", "budget_mcp"]) {
    await admin.$executeRawUnsafe(`GRANT ${r} TO ${roleName} WITH ADMIN OPTION`);
  }
  for (const t of ["organization", "app_user", "role_assignment"]) {
    await admin.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE ON ${t} TO ${roleName}`);
    await admin.$executeRawUnsafe(`CREATE POLICY owner_bootstrap_test ON ${t} FOR ALL TO ${roleName} USING (true) WITH CHECK (true)`);
  }
  // The metrics-seeding read touches workspace even for a brand-new org with none yet (it reads
  // zero rows under the ordinary org_read policy — RLS still requires the base table privilege).
  await admin.$executeRawUnsafe(`GRANT SELECT ON workspace TO ${roleName}`);
  // S-9: this role also needs to rotate the three login roles' passwords (ALTER ROLE ... LOGIN
  // PASSWORD) and call app_lock_placeholder_logins() (SECURITY DEFINER, owned by `budget`, whose
  // EXECUTE is revoked from PUBLIC) and write app_role_state, exactly like the real owner.
  await admin.$executeRawUnsafe(`GRANT EXECUTE ON FUNCTION app_lock_placeholder_logins() TO ${roleName}`);
  await admin.$executeRawUnsafe(`GRANT SELECT, UPDATE ON app_role_state TO ${roleName}`);
});

afterAll(async () => {
  await asThrowawayOwner.$disconnect();
  for (const t of ["organization", "app_user", "role_assignment"]) {
    await admin.$executeRawUnsafe(`DROP POLICY IF EXISTS owner_bootstrap_test ON ${t}`);
  }
  await admin.$executeRawUnsafe(`DROP OWNED BY ${roleName}`);
  await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS ${roleName}`);
  await admin.$disconnect();
});

function env(email: string, orgName: string): NodeJS.ProcessEnv {
  return {
    APP_DB_PASSWORD: PLACEHOLDER,
    PUBLISHER_DB_PASSWORD: PLACEHOLDER,
    MCP_DB_PASSWORD: PLACEHOLDER,
    SUPERADMIN_EMAIL: email,
    ORG_NAME: orgName,
  };
}

describe("bootstrap() without BYPASSRLS (W2-3 done-when, audit S-2, S-3, S-21)", () => {
  it("creates the org, the superadmin user and their ORG_ADMIN assignment, and the owner role never holds BYPASSRLS", async () => {
    const email = `superadmin-${randomUUID()}@w23.test`;
    const orgName = `W2-3 ${randomUUID()}`;

    const before = await asThrowawayOwner.$queryRawUnsafe<Array<{ rolbypassrls: boolean; rolsuper: boolean }>>(
      "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user",
    );
    expect(before[0]).toMatchObject({ rolbypassrls: false, rolsuper: false });

    const result = await bootstrap(asThrowawayOwner, env(email, orgName));
    expect(result.orgId).toBeTruthy();
    expect(result.userId).toBeTruthy();

    const user = await asThrowawayOwner.user.findUniqueOrThrow({ where: { id: result.userId } });
    expect(user).toMatchObject({ email, orgId: result.orgId, isActive: true });

    const admin1 = await asThrowawayOwner.roleAssignment.findFirst({
      where: { workspaceId: null, principalType: "user", principalId: result.userId, role: "ORG_ADMIN" },
    });
    expect(admin1).not.toBeNull();

    // Done when (brief item 4): the owner role still has no BYPASSRLS after bootstrap runs.
    const after = await asThrowawayOwner.$queryRawUnsafe<Array<{ rolbypassrls: boolean; rolsuper: boolean }>>(
      "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user",
    );
    expect(after[0]).toMatchObject({ rolbypassrls: false, rolsuper: false });
  });

  it("is idempotent: a second run for the same email returns the same org and user, with one role assignment", async () => {
    const email = `superadmin-${randomUUID()}@w23.test`;
    const orgName = `W2-3 ${randomUUID()}`;
    const first = await bootstrap(asThrowawayOwner, env(email, orgName));
    const second = await bootstrap(asThrowawayOwner, env(email, orgName));
    expect(second).toEqual(first);
    const assignments = await asThrowawayOwner.roleAssignment.findMany({
      where: { workspaceId: null, principalType: "user", principalId: first.userId, role: "ORG_ADMIN" },
    });
    expect(assignments).toHaveLength(1);
  });

  it("reuses an existing organization by name for a second superadmin", async () => {
    const orgName = `W2-3 shared ${randomUUID()}`;
    const first = await bootstrap(asThrowawayOwner, env(`one-${randomUUID()}@w23.test`, orgName));
    const second = await bootstrap(asThrowawayOwner, env(`two-${randomUUID()}@w23.test`, orgName));
    expect(second.orgId).toBe(first.orgId);
    expect(second.userId).not.toBe(first.userId);
  });
});

// S-9 (docs/STACK_AUDIT_2026-10-04.md): `--check-secrets` must fail BEFORE `prisma migrate
// deploy` runs, naming whichever of the four deploy secrets is missing, so a half-configured
// deploy never reaches the database. These are pure unit tests (no process spawn, no DB): they
// exercise the exact functions the `--check-secrets` CLI path (bottom of bootstrap.ts) calls.
describe("assertDeploySecrets / checkSecretsStatus (S-9 --check-secrets)", () => {
  const allFour = {
    APP_DB_PASSWORD: "app-secret",
    PUBLISHER_DB_PASSWORD: "publisher-secret",
    MCP_DB_PASSWORD: "mcp-secret",
    SUPERADMIN_EMAIL: "owner@example.com",
  };

  it("assertDeploySecrets passes when all four deploy secrets are set", () => {
    expect(() => assertDeploySecrets(allFour)).not.toThrow();
  });

  for (const missing of ["APP_DB_PASSWORD", "PUBLISHER_DB_PASSWORD", "MCP_DB_PASSWORD", "SUPERADMIN_EMAIL"] as const) {
    it(`assertDeploySecrets throws naming ${missing} when it is absent`, () => {
      const envVars = { ...allFour, [missing]: undefined };
      expect(() => assertDeploySecrets(envVars)).toThrow(new RegExp(`${missing} is required`));
    });
  }

  it("checkSecretsStatus is ok (exit 0) when every secret is present", () => {
    expect(checkSecretsStatus(allFour)).toEqual({ ok: true });
  });

  it("checkSecretsStatus is not ok (exit non-zero) and names the missing key", () => {
    const rest = { ...allFour, MCP_DB_PASSWORD: undefined };
    const status = checkSecretsStatus(rest);
    expect(status.ok).toBe(false);
    expect(status).toMatchObject({ message: expect.stringContaining("MCP_DB_PASSWORD is required") });
  });
});
