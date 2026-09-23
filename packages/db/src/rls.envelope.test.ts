import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { expect, it } from "vitest";

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
const appUrl =
  process.env["APP_DATABASE_URL"] ??
  "postgresql://budget_app:replace-in-secret-manager@localhost:5432/budget";

const workspaceA = "01927a00-0000-7000-8000-0000000000a1";
const workspaceB = "01927a00-0000-7000-8000-0000000000b2";
const envelopeA = "01927a00-0000-7000-8000-0000000000e1";
const envelopeB = "01927a00-0000-7000-8000-0000000000e2";
const actorId = "01927a00-0000-7000-8000-0000000000c1";

const tenantRelations = ["subscription", "notification", "processed_event", "bulk_change", "envelope"];

async function withClient<T>(connectionString: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function visibleEnvelopeIds(app: Client, workspaceId: string): Promise<string[]> {
  await app.query("BEGIN");
  try {
    await app.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    await app.query("SELECT set_config('app.user_id', $1, true)", [actorId]);
    await app.query("SELECT set_config('app.is_org_admin', 'false', true)");
    const result = await app.query<{ id: string }>(
      "SELECT id::text AS id FROM envelope WHERE id IN ($1::uuid, $2::uuid)",
      [envelopeA, envelopeB],
    );
    return result.rows.map((row) => row.id);
  } finally {
    await app.query("ROLLBACK");
  }
}

it("budget_app cannot read another workspace's envelope", async () => {
  await withClient(ownerUrl, async (owner) => {
    for (const relation of tenantRelations) {
      const found = await owner.query<{ ok: boolean }>("SELECT to_regclass($1) IS NOT NULL AS ok", [
        `public.${relation}`,
      ]);
      expect(found.rows[0]?.ok, relation).toBe(true);
    }
    const eligible = await owner.query<{ ok: boolean }>(
      "SELECT to_regprocedure('public.eligible_approver(uuid,uuid)') IS NOT NULL AS ok",
    );
    const effective = await owner.query<{ ok: boolean }>(
      "SELECT to_regprocedure('public.effective_target(uuid,text)') IS NOT NULL AS ok",
    );
    expect(eligible.rows[0]?.ok, "eligible_approver").toBe(true);
    expect(effective.rows[0]?.ok, "effective_target").toBe(true);

    await owner.query("DELETE FROM envelope WHERE id IN ($1::uuid, $2::uuid)", [envelopeA, envelopeB]);
    await owner.query(
      `INSERT INTO envelope (
         id, workspace_id, name, dimension_values, start_date, end_date, currency, created_by, updated_at
       ) VALUES
         ($1::uuid, $2::uuid, 'rls-a', '{}'::jsonb, DATE '2026-01-01', DATE '2026-12-31', 'USD', $3::uuid, now()),
         ($4::uuid, $5::uuid, 'rls-b', '{}'::jsonb, DATE '2026-01-01', DATE '2026-12-31', 'USD', $3::uuid, now())`,
      [envelopeA, workspaceA, actorId, envelopeB, workspaceB],
    );

    try {
      await withClient(appUrl, async (app) => {
        const role = await app.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        );
        expect(role.rows[0]?.rolsuper, "budget_app is not a superuser").toBe(false);
        expect(role.rows[0]?.rolbypassrls, "budget_app does not bypass RLS").toBe(false);

        const asA = await visibleEnvelopeIds(app, workspaceA);
        expect(asA).toContain(envelopeA);
        expect(asA).not.toContain(envelopeB);

        const asB = await visibleEnvelopeIds(app, workspaceB);
        expect(asB).toContain(envelopeB);
        expect(asB).not.toContain(envelopeA);
      });
    } finally {
      await owner.query("DELETE FROM envelope WHERE id IN ($1::uuid, $2::uuid)", [envelopeA, envelopeB]);
    }
  });
});
