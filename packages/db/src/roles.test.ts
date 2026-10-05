import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

const ownerUrl = process.env["DATABASE_URL"] ?? "postgresql://budget:budget@localhost:5432/budget";

const builtinRoles = ["budget_app", "budget_publisher", "budget_mcp"];
const testRole = "budget_test_w27_lock_role";
const testRolePassword = "placeholder-test-pw";
const rotatedPassword = "rotated-test-pw";

async function withClient<T>(connectionString: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function urlFor(role: string, password: string): string {
  const url = new URL(ownerUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

// S-9 (docs/STACK_AUDIT_2026-10-04.md): migration 20261010020000_role_placeholder_lock adds
// app_role_state and app_lock_placeholder_logins(). Both this migration and bootstrap.ts's
// behaviour are covered here.
describe("role placeholder lock (S-9)", () => {
  it("after migrations, the three login roles exist and app_role_state tracks them as placeholder", async () => {
    await withClient(ownerUrl, async (owner) => {
      const roles = await owner.query<{ rolname: string; rolcanlogin: boolean }>(
        "SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = ANY($1::text[])",
        [builtinRoles],
      );
      expect(roles.rows.map((r) => r.rolname).sort()).toEqual([...builtinRoles].sort());
      for (const row of roles.rows) {
        expect(row.rolcanlogin, row.rolname).toBe(true);
      }

      const state = await owner.query<{ role_name: string; placeholder: boolean; rotated_at: Date | null }>(
        "SELECT role_name, placeholder, rotated_at FROM app_role_state WHERE role_name = ANY($1::text[]) ORDER BY role_name",
        [builtinRoles],
      );
      expect(state.rows.map((r) => r.role_name)).toHaveLength(3);
      for (const row of state.rows) {
        expect(row.placeholder, row.role_name).toBe(true);
        expect(row.rotated_at, row.role_name).toBeNull();
      }

      const fn = await owner.query<{ prosecdef: boolean }>(
        "SELECT prosecdef FROM pg_proc WHERE proname = 'app_lock_placeholder_logins'",
      );
      expect(fn.rows).toHaveLength(1);
      expect(fn.rows[0]?.prosecdef, "app_lock_placeholder_logins is SECURITY DEFINER").toBe(true);

      const grants = await owner.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM information_schema.routine_privileges WHERE routine_name = 'app_lock_placeholder_logins' AND grantee = 'PUBLIC'",
      );
      expect(grants.rows[0]?.count, "EXECUTE on app_lock_placeholder_logins is revoked from PUBLIC").toBe("0");
    });
  });

  // budget_app/budget_publisher/budget_mcp are cluster-wide login roles shared live with every
  // other worktree's test run against this same Postgres container (AGENT_BRIEF: "already exist
  // cluster-wide"). Actually locking or rotating them here would flip real, global login state
  // out from under sibling worktrees mid-test — a database-level action, not one this test's own
  // transaction can contain. So this suite exercises the exact mechanism bootstrap.ts relies on
  // (ALTER ROLE ... NOLOGIN / LOGIN PASSWORD, app_role_state bookkeeping, and
  // app_lock_placeholder_logins() itself) against a disposable synthetic role scoped to this test,
  // after first marking the three real roles "already rotated" in THIS database's app_role_state
  // (a local bookkeeping row, not a cluster-wide change) so the lock function leaves them alone.
  describe("lock / rotate mechanism (synthetic role; the shared app roles are left untouched)", () => {
    beforeAll(async () => {
      await withClient(ownerUrl, async (owner) => {
        await owner.query(
          "UPDATE app_role_state SET placeholder = false, rotated_at = now() WHERE role_name = ANY($1::text[])",
          [builtinRoles],
        );
        await owner.query(`DROP ROLE IF EXISTS ${testRole}`);
        await owner.query(`CREATE ROLE ${testRole} LOGIN PASSWORD '${testRolePassword}'`);
        await owner.query(
          "INSERT INTO app_role_state (role_name, placeholder) VALUES ($1, true) ON CONFLICT (role_name) DO UPDATE SET placeholder = true, rotated_at = NULL",
          [testRole],
        );
      });
    });

    afterAll(async () => {
      await withClient(ownerUrl, async (owner) => {
        await owner.query(`DROP ROLE IF EXISTS ${testRole}`);
        await owner.query("DELETE FROM app_role_state WHERE role_name = $1", [testRole]);
        // Leave this database's bookkeeping the way a fresh migration would, so a repeat local
        // run of the first test in this file still sees the three roles as not-yet-rotated.
        await owner.query(
          "UPDATE app_role_state SET placeholder = true, rotated_at = NULL WHERE role_name = ANY($1::text[])",
          [builtinRoles],
        );
      });
    });

    it("the synthetic role can connect with its password before locking", async () => {
      await withClient(urlFor(testRole, testRolePassword), async (client) => {
        await client.query("SELECT 1");
      });
    });

    it("app_lock_placeholder_logins() sets NOLOGIN; the connection is then refused", async () => {
      await withClient(ownerUrl, async (owner) => {
        await owner.query("SELECT app_lock_placeholder_logins()");
      });
      await expect(
        withClient(urlFor(testRole, testRolePassword), async (client) => client.query("SELECT 1")),
      ).rejects.toThrow(/not permitted to log in/);
    });

    it("bootstrap's rotation (ALTER ROLE ... LOGIN PASSWORD, placeholder = false) restores LOGIN", async () => {
      await withClient(ownerUrl, async (owner) => {
        // The same two statements bootstrap() runs per role in apps/api/src/deploy/bootstrap.ts.
        await owner.query(`ALTER ROLE ${testRole} LOGIN PASSWORD '${rotatedPassword}'`);
        await owner.query(
          "UPDATE app_role_state SET placeholder = false, rotated_at = now() WHERE role_name = $1",
          [testRole],
        );
      });
      await withClient(urlFor(testRole, rotatedPassword), async (client) => {
        await client.query("SELECT 1");
      });
      await expect(
        withClient(urlFor(testRole, testRolePassword), async (client) => client.query("SELECT 1")),
      ).rejects.toThrow();

      await withClient(ownerUrl, async (owner) => {
        const state = await owner.query<{ placeholder: boolean; rotated_at: Date | null }>(
          "SELECT placeholder, rotated_at FROM app_role_state WHERE role_name = $1",
          [testRole],
        );
        expect(state.rows[0]?.placeholder).toBe(false);
        expect(state.rows[0]?.rotated_at).not.toBeNull();
      });
    });
  });
});
