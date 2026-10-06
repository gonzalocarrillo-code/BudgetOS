import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

/**
 * D-001 local clause (docs/DATA_PLAN.md §1): the Datastream module in infra/modules/datastream.
 * The stream itself needs a GCP project; here the module and setup.sql are checked against each
 * other and against the schema: the publication and slot names match, partitioned facts publish
 * under their parent, the replication role cannot write, and the excluded tables are exactly the
 * transient ones, so every tenant table (snapshots and audit included) replicates.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const dir = join(repoRoot, "infra/modules/datastream");
const mainTf = readFileSync(join(dir, "main.tf"), "utf8");
const setup = readFileSync(join(dir, "setup.sql"), "utf8");
for (const line of readFileSync(join(repoRoot, "packages/db/.env"), "utf8").split("\n")) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m?.[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
const owner = new PrismaClient({ datasources: { db: { url: process.env["DATABASE_URL"] ?? "" } } });
afterAll(() => owner.$disconnect());

const excluded = JSON.parse(/excluded_tables = (\[[^\]]*\])/.exec(mainTf)?.[1] ?? "[]") as string[];

describe("Datastream replica (infra/modules/datastream)", () => {
  it("the stream reads the publication and slot setup.sql creates, into the bigquery module's dataset", () => {
    expect(mainTf).toContain('publication      = "budget_os_datastream"');
    expect(mainTf).toContain('replication_slot = "budget_os_datastream"');
    expect(setup).toContain("CREATE PUBLICATION budget_os_datastream FOR ALL TABLES WITH (publish_via_partition_root = true)");
    expect(setup).toContain("pg_create_logical_replication_slot('budget_os_datastream', 'pgoutput')");
    expect(mainTf).toMatch(/single_target_dataset \{\s+dataset_id = "\$\{var\.project_id\}:\$\{var\.dataset_id\}"/);
    expect(mainTf).toContain("backfill_all {}");
  });

  it("I-8: the BigQuery destination is append-only, so a Postgres DELETE (including retention's own) never erases a BigQuery row", () => {
    const destination = /bigquery_destination_config \{([\s\S]*?)\n {4}\}/.exec(mainTf)?.[1] ?? "";
    expect(destination).toContain("append_only {}");
    // Append-only is the opt-in: the default without it is merge mode, which applies DELETEs.
    expect(destination).not.toMatch(/\bmerge\s*\{/);
  });

  it("the replication role reads everything and writes nothing", () => {
    expect(setup).toContain("CREATE ROLE budget_datastream WITH LOGIN REPLICATION BYPASSRLS");
    expect(setup).toContain("GRANT SELECT ON ALL TABLES IN SCHEMA public TO budget_datastream");
    expect(setup).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE|ALL)/i);
  });

  it("excludes only the transient tables; every tenant table replicates, snapshots and audit included", async () => {
    expect(excluded.sort()).toEqual(["_prisma_migrations", "outbox", "processed_event"]);
    const tables = await owner.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT c.table_name FROM information_schema.columns c JOIN pg_class p ON p.relname = c.table_name
       WHERE c.table_schema = 'public' AND c.column_name = 'workspace_id' AND NOT p.relispartition`,
    );
    const tenant = new Set(tables.map((t) => t.table_name));
    for (const t of ["budget_baseline", "budget_baseline_row", "audit_event", "envelope", "spend_fact", "kpi_fact", "projection_fact"]) expect(tenant.has(t), t).toBe(true);
    expect([...tenant].filter((t) => excluded.includes(t)).filter((t) => t !== "outbox")).toEqual([]);
    for (const t of excluded) {
      const [row] = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM pg_class WHERE relname = $1`, t);
      expect(Number(row?.n), `${t} exists`).toBeGreaterThan(0);
    }
  });
});
