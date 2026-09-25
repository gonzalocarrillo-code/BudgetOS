import { afterAll, describe, expect, it } from "vitest";
import { mcpDb, ownerDb } from "./test-support/harness.js";

/**
 * T-025 guard, database half (spec §16, ADR-019); the import half is import-guard.test.ts. The
 * MCP server connects as
 * `budget_mcp`, which has SELECT on what budget_app reads and INSERT on audit_event only, so a
 * write is refused by Postgres itself.
 */

const owner = ownerDb();
const mcp = mcpDb();
afterAll(() => Promise.all([owner.$disconnect(), mcp.$disconnect()]));

describe("read-only MCP (T-025 guard)", () => {
  it("budget_mcp: SELECT where budget_app reads, INSERT on audit_event only, no UPDATE or DELETE anywhere", async () => {
    const grants = await owner.$queryRawUnsafe<Array<{ grantee: string; table_name: string; privilege_type: string }>>(
      `SELECT g.grantee, g.table_name, g.privilege_type FROM information_schema.role_table_grants g
       JOIN pg_class c ON c.relname = g.table_name JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       WHERE g.table_schema = 'public' AND g.grantee IN ('budget_app', 'budget_mcp') AND NOT c.relispartition`,
    );
    const mcpWrites = grants.filter((g) => g.grantee === "budget_mcp" && g.privilege_type !== "SELECT").map((g) => `${g.privilege_type} ${g.table_name}`);
    expect(mcpWrites).toEqual(["INSERT audit_event"]);
    const reads = (who: string) => new Set(grants.filter((g) => g.grantee === who && g.privilege_type === "SELECT").map((g) => g.table_name));
    const missing = [...reads("budget_app")].filter((t) => !["_prisma_migrations", "outbox", "processed_event"].includes(t) && !reads("budget_mcp").has(t));
    expect(missing, "a new table needs GRANT SELECT … TO budget_mcp (ADR-019)").toEqual([]);
    expect(reads("budget_mcp").has("outbox")).toBe(false);
  });

  it("Postgres refuses writes made as budget_mcp", async () => {
    for (const sql of [`UPDATE envelope SET name = name WHERE false`, `DELETE FROM audit_event WHERE false`, `INSERT INTO tag (id, workspace_id, name) SELECT gen_random_uuid(), gen_random_uuid(), 'x' WHERE false`, `SELECT count(*) FROM outbox`]) {
      await expect(mcp.$executeRawUnsafe(sql), sql).rejects.toThrow(/permission denied/);
    }
  });
});
