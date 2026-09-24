import pg from "pg";
import type { CompiledQuery } from "../compile-query.js";
import "./env.js";

const ownerUrl = process.env["DATABASE_URL"] ?? "postgresql://budget:budget@localhost:5432/budget";
const appUrl =
  process.env["APP_DATABASE_URL"] ??
  "postgresql://budget_app:replace-in-secret-manager@localhost:5432/budget";

/** Fixture writer. Only test code uses the owner role. */
export const owner = new pg.Pool({ connectionString: ownerUrl, max: 4 });
/** Planner reads run as the application role so RLS applies. */
export const app = new pg.Pool({ connectionString: appUrl, max: 4 });

export type Row = Record<string, unknown>;

/** Runs a compiled planner query as budget_app with the tenant settings withTenant() applies. */
export async function runAsApp(
  c: CompiledQuery,
  tenant: { workspaceId: string; userId: string | null },
): Promise<Row[]> {
  // The API sets app.org_id from the caller; fixtures only know the workspace, so look it up as
  // the owner (workspace has org-scoped RLS for budget_app).
  const org = await owner.query<{ org_id: string }>(`SELECT org_id::text AS org_id FROM workspace WHERE id = $1::uuid`, [
    tenant.workspaceId,
  ]);
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [tenant.workspaceId]);
    await client.query(`SELECT set_config('app.org_id', $1, true)`, [org.rows[0]?.org_id ?? ""]);
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [tenant.userId ?? ""]);
    await client.query(`SELECT set_config('app.is_org_admin', 'false', true)`);
    const result = await client.query<Row>(c.sql, c.values);
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function closePools(): Promise<void> {
  await Promise.all([owner.end(), app.end()]);
}
