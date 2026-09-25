import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

/**
 * T-023 local clause (LOCAL_BUILD_PHASES phase 13, ADR-017): the curated BigQuery views of plan
 * §6.2 in infra/modules/bigquery. They are written in the SQL both engines share, so each one is
 * created here as a Postgres temp view over the real schema (every table and column must exist)
 * and v_budget_current is checked on a small fixture. "Views queryable" in BigQuery stays blocked.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const moduleDir = join(repoRoot, "infra/modules/bigquery");
for (const line of existsSync(join(repoRoot, "packages/db/.env")) ? readFileSync(join(repoRoot, "packages/db/.env"), "utf8").split("\n") : []) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m?.[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
const owner = new PrismaClient({ datasources: { db: { url: process.env["DATABASE_URL"] ?? "" } } });
afterAll(() => owner.$disconnect());

const PLAN_VIEWS = ["v_approvals", "v_budget_current", "v_budget_vs_actual_daily", "v_closures"];
const mainTf = readFileSync(join(moduleDir, "main.tf"), "utf8");
const block = (name: string) => [...(new RegExp(`\\n  ${name} = \\{\\n([\\s\\S]*?)\\n  \\}`).exec(mainTf)?.[1] ?? "").matchAll(/^\s+(\w+)\s+=/gm)].map((m) => m[1] as string);
const base = block("views");
const derived = block("derived_views");
const sql = (view: string) => readFileSync(join(moduleDir, "views", `${view}.sql`), "utf8");
const REF = /`\$\{project\}\.\$\{dataset\}\.(\w+)`/g;
/** BigQuery → Postgres: the only difference allowed is the `project.dataset.` table prefix. */
const forPostgres = (text: string) => text.replace(REF, "$1");

class Rollback extends Error {}
async function inRolledBackTx(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  await owner
    .$transaction(async (tx) => {
      for (const v of [...base, ...derived]) await tx.$executeRawUnsafe(`CREATE TEMP VIEW ${v} AS ${forPostgres(sql(v))}`);
      await fn(tx);
      throw new Rollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
}

describe("BigQuery curated views (infra/modules/bigquery)", () => {
  it("declares exactly the plan's views, each with its SQL file; derived views read only declared views", () => {
    expect([...base, ...derived].sort()).toEqual(PLAN_VIEWS);
    expect(readdirSync(join(moduleDir, "views")).sort()).toEqual(PLAN_VIEWS.map((v) => `${v}.sql`));
    for (const v of base) expect([...sql(v).matchAll(REF)].map((m) => m[1]).filter((t) => PLAN_VIEWS.includes(t as string))).toEqual([]);
    for (const v of derived) expect([...sql(v).matchAll(REF)].map((m) => m[1]).filter((t) => (t as string).startsWith("v_")).every((t) => base.includes(t as string))).toBe(true);
    expect(mainTf).toContain("depends_on          = [google_bigquery_table.view]");
  });

  it("every view runs against the Postgres schema the replica mirrors", async () => {
    await inRolledBackTx(async (tx) => {
      for (const v of PLAN_VIEWS) await tx.$queryRawUnsafe(`SELECT * FROM ${v} LIMIT 0`);
    });
  });

  it("v_budget_current: the latest approved BUDGET version, reporting amounts, live-leaf flag", async () => {
    const [org, ws, user, parent, child, archived] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await inRolledBackTx(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO organization (id, name) VALUES ($1::uuid, 't023-bq')`, org);
      await tx.$executeRawUnsafe(`INSERT INTO workspace (id, org_id, slug, name, reporting_currency) VALUES ($1::uuid, $2::uuid, $3, 'T-023 BQ', 'USD')`, ws, org, `t023-bq-${ws}`);
      await tx.$executeRawUnsafe(`INSERT INTO app_user (id, org_id, email, name, google_sub) VALUES ($1::uuid, $2::uuid, $3, 't023', $3)`, user, org, `${user}@t023.test`);
      for (const [id, parentId, status] of [[parent, null, "APPROVED"], [child, parent, "APPROVED"], [archived, parent, "ARCHIVED"]] as const) {
        await tx.$executeRawUnsafe(
          `INSERT INTO envelope (id, workspace_id, parent_id, name, dimension_values, start_date, end_date, currency, status, created_by, updated_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $1, '{}', '2026-01-01', '2026-12-31', 'EUR', $4::"EnvelopeStatus", $5::uuid, now())`,
          id, ws, parentId, status, user,
        );
      }
      const version = (envelopeId: string, no: number, amount: string, status: string, approvedAt: string | null) =>
        tx.$executeRawUnsafe(
          `INSERT INTO envelope_version (id, envelope_id, version_no, amount, amount_reporting, status, created_by, approved_at) VALUES ($1::uuid, $2::uuid, $3, $4::numeric, $4::numeric * 1.1, $5::"VersionStatus", $6::uuid, $7::timestamptz)`,
          randomUUID(), envelopeId, no, amount, status, user, approvedAt,
        );
      await version(child, 1, "100.00", "SUPERSEDED", "2026-02-01T00:00:00Z");
      await version(child, 2, "150.00", "APPROVED", "2026-03-01T00:00:00Z");
      await version(child, 3, "999.00", "DRAFT", null);
      await version(parent, 1, "500.00", "APPROVED", "2026-01-15T00:00:00Z");
      const rows = await tx.$queryRawUnsafe<Array<{ envelope_id: string; amount: string | null; amount_reporting: string | null; version_no: number | null; is_leaf: boolean; currency: string; reporting_currency: string }>>(
        `SELECT envelope_id::text, amount::text, amount_reporting::text, version_no, is_leaf, currency::text, reporting_currency::text FROM v_budget_current WHERE workspace_id = $1::uuid ORDER BY envelope_id`,
        ws,
      );
      const byId = Object.fromEntries(rows.map((r) => [r.envelope_id, r]));
      expect(byId[child]).toMatchObject({ amount: "150.00", amount_reporting: "165.00", version_no: 2, is_leaf: true, currency: "EUR", reporting_currency: "USD" });
      // The archived child does not make its parent a parent: only the live child does.
      expect(byId[parent]).toMatchObject({ amount: "500.00", is_leaf: false });
      expect(byId[archived]).toMatchObject({ amount: null, is_leaf: true });
    });
  });
});
