import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listFactDimensionValues } from "./fact-dimension-values.js";
import { ensurePartitions } from "./facts.js";
import { asOrgAdmin, withTenant, type TenantContext } from "./tenant.js";
import type { Tx } from "./sql.js";

/**
 * EX-9 (ADR-0094): a `values_source = 'facts'` dimension (campaign) lists the distinct values its
 * live facts carry — never registry rows. Each value has its live spend (Decimal, reporting
 * currency), first/last fact date and source systems, across spend_fact and kpi_fact. Superseded
 * facts are not read; demo facts follow ADR-082 (counted only while the workspace is pure demo, or
 * when asked). Server-side search and pagination. Runs as budget_app under RLS.
 */

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
function loadEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const i = trimmed.indexOf("=");
    if (i === -1) continue;
    const key = trimmed.slice(0, i).trim();
    if (process.env[key] === undefined) process.env[key] = trimmed.slice(i + 1).trim();
  }
}
loadEnv(join(packageRoot, ".env"));

const owner = new PrismaClient({ datasources: { db: { url: process.env["DATABASE_URL"] ?? "" } } });
const app = new PrismaClient({ datasources: { db: { url: process.env["APP_DATABASE_URL"] ?? "" } } });
const orgId = randomUUID();
const ws = randomUUID();
const otherWs = randomUUID();
const userId = randomUUID();
const ctx = (workspaceId = ws): TenantContext => ({ workspaceId, orgId, userId, isOrgAdmin: false, actorType: "user", requestId: `ex9-${randomUUID()}` });
const asApp = <T>(fn: (tx: Tx) => Promise<T>, workspaceId = ws) => withTenant(app, ctx(workspaceId), fn);
const asOwner = <T>(fn: (tx: Tx) => Promise<T>) => asOrgAdmin(owner, fn, orgId);

let seq = 0;
async function spend(campaign: string | null, date: string, amount: string, opts: { demo?: boolean; superseded?: boolean; source?: string; workspaceId?: string } = {}): Promise<void> {
  const hash = `ex9-s-${++seq}`;
  const dims = campaign === null ? { platform: "meta" } : { platform: "meta", campaign };
  await asOwner((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO spend_fact (workspace_id, dimension_values, period_date, currency, amount, amount_reporting, source_system, source_run_id, source_row_hash, natural_key, demo, superseded_at)
       VALUES ($1::uuid, $2::jsonb, $3::date, 'EUR', $4::numeric, $4::numeric, $5, $6::uuid, $7, $7, $8, $9)`,
      opts.workspaceId ?? ws,
      JSON.stringify(dims),
      date,
      amount,
      opts.source ?? "bigquery",
      randomUUID(),
      hash,
      opts.demo ?? false,
      opts.superseded ? new Date() : null,
    ),
  );
}
async function kpi(campaign: string, date: string, value: string, opts: { source?: string } = {}): Promise<void> {
  const hash = `ex9-k-${++seq}`;
  await asOwner((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO kpi_fact (workspace_id, dimension_values, period_date, metric, value, source_system, source_run_id, source_row_hash, natural_key)
       VALUES ($1::uuid, $2::jsonb, $3::date, 'conversions', $4::numeric, $5, $6::uuid, $7, $7)`,
      ws,
      JSON.stringify({ platform: "meta", campaign }),
      date,
      value,
      opts.source ?? "snowflake",
      randomUUID(),
      hash,
    ),
  );
}

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "ex9" } });
  await asOwner((tx) => tx.workspace.createMany({ data: [ws, otherWs].map((id) => ({ id, orgId, slug: `ex9-${id}`, name: "EX-9", reportingCurrency: "EUR" })) }));
  await owner.user.create({ data: { id: userId, orgId, email: `${userId}@ex9.test`, name: "EX-9", googleSub: `g-${userId}` } });
  await ensurePartitions(owner, "2026-01-01", "2026-12-31");
  // Spring_Sale: two spend rows (one superseded, not read), a KPI row extends its last date.
  await spend("Spring_Sale", "2026-02-03", "100.10");
  await spend("Spring_Sale", "2026-02-10", "0.20");
  await spend("Spring_Sale", "2026-01-01", "999.00", { superseded: true });
  await kpi("Spring_Sale", "2026-03-15", "4");
  // Summer_Launch: biggest spender, two sources.
  await spend("Summer_Launch", "2026-05-01", "250.00", { source: "bigquery" });
  await spend("Summer_Launch", "2026-05-02", "250.05", { source: "manual" });
  // Brand_Always_On: KPI only (no spend) — still a campaign the data knows.
  await kpi("Brand_Always_On", "2026-04-01", "9");
  // Not a campaign: no `campaign` key.
  await spend(null, "2026-02-01", "77.00");
  // Demo only.
  await spend("Demo_Campaign", "2026-02-01", "5000.00", { demo: true, source: "demo" });
  // Another workspace's campaign never shows.
  await spend("Other_WS_Campaign", "2026-02-01", "1.00", { workspaceId: otherWs });
}, 60_000);

afterAll(async () => {
  await asOwner(async (tx) => {
    for (const t of ["spend_fact", "kpi_fact", "envelope"]) await tx.$executeRawUnsafe(`DELETE FROM ${t} WHERE workspace_id = ANY($1::uuid[])`, [ws, otherWs]);
    await tx.$executeRawUnsafe(`DELETE FROM workspace WHERE id = ANY($1::uuid[])`, [ws, otherWs]);
  });
  await owner.user.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("listFactDimensionValues (EX-9)", () => {
  it("equals the facts' distinct live campaigns, with Σ spend (Decimal), first/last seen and sources; largest spend first", async () => {
    const page = await asApp((tx) => listFactDimensionValues(tx, { workspaceId: ws, key: "campaign" }));
    // The ground truth, straight from the facts (pure demo workspace: demo counts, ADR-082).
    const truth = await asOwner((tx) =>
      tx.$queryRawUnsafe<Array<{ code: string; spend: string }>>(
        `SELECT code, coalesce(sum(amount), 0)::text AS spend FROM (
           SELECT dimension_values ->> 'campaign' AS code, amount_reporting AS amount FROM spend_fact WHERE workspace_id = $1::uuid AND superseded_at IS NULL AND dimension_values ? 'campaign'
           UNION ALL
           SELECT dimension_values ->> 'campaign', NULL FROM kpi_fact WHERE workspace_id = $1::uuid AND superseded_at IS NULL AND dimension_values ? 'campaign'
         ) f GROUP BY code`,
        ws,
      ),
    );
    expect(new Set(page.items.map((i) => i.code))).toEqual(new Set(truth.map((r) => r.code)));
    for (const r of truth) expect(page.items.find((i) => i.code === r.code)?.spend).toBe(new Decimal(r.spend).toFixed(2));
    expect(page.total).toBe(4);
    expect(page.items.map((i) => i.code)).toEqual(["Demo_Campaign", "Summer_Launch", "Spring_Sale", "Brand_Always_On"]);
    expect(page.items.find((i) => i.code === "Spring_Sale")).toEqual({ code: "Spring_Sale", spend: "100.30", currency: "EUR", firstSeen: "2026-02-03", lastSeen: "2026-03-15", sourceSystems: ["bigquery", "snowflake"] });
    expect(page.items.find((i) => i.code === "Summer_Launch")).toMatchObject({ spend: "500.05", sourceSystems: ["bigquery", "manual"] });
    expect(page.items.find((i) => i.code === "Brand_Always_On")).toMatchObject({ spend: "0.00", firstSeen: "2026-04-01", lastSeen: "2026-04-01" });
  });

  it("searches (case-insensitive substring) and pages on the server", async () => {
    const hit = await asApp((tx) => listFactDimensionValues(tx, { workspaceId: ws, key: "campaign", q: "s" + "ALE" }));
    expect(hit.items.map((i) => i.code)).toEqual(["Spring_Sale"]);
    expect(hit.total).toBe(1);
    const p1 = await asApp((tx) => listFactDimensionValues(tx, { workspaceId: ws, key: "campaign", limit: 2, offset: 0 }));
    const p2 = await asApp((tx) => listFactDimensionValues(tx, { workspaceId: ws, key: "campaign", limit: 2, offset: 2 }));
    expect([...p1.items, ...p2.items].map((i) => i.code)).toEqual(["Demo_Campaign", "Summer_Launch", "Spring_Sale", "Brand_Always_On"]);
    expect([p1.total, p2.total, p1.limit, p2.offset]).toEqual([4, 4, 2, 2]);
    // LIKE metacharacters are literal.
    expect((await asApp((tx) => listFactDimensionValues(tx, { workspaceId: ws, key: "campaign", q: "%" }))).total).toBe(0);
  });

  it("ADR-082: once the workspace has a real budget, demo facts drop out unless asked for", async () => {
    await asOwner((tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO envelope (id, workspace_id, name, dimension_values, start_date, end_date, currency, status, created_by, updated_at)
         VALUES ($1::uuid, $2::uuid, 'Real', '{}'::jsonb, '2026-01-01', '2026-12-31', 'EUR', 'APPROVED', $3::uuid, now())`,
        randomUUID(),
        ws,
        userId,
      ),
    );
    const real = await asApp((tx) => listFactDimensionValues(tx, { workspaceId: ws, key: "campaign" }));
    expect(real.items.map((i) => i.code)).not.toContain("Demo_Campaign");
    expect(real.total).toBe(3);
    const withDemo = await asApp((tx) => listFactDimensionValues(tx, { workspaceId: ws, key: "campaign", includeDemo: true }));
    expect(withDemo.items.map((i) => i.code)).toContain("Demo_Campaign");
  });

  it("is tenant-isolated: another workspace's facts never show", async () => {
    const other = await asApp((tx) => listFactDimensionValues(tx, { workspaceId: otherWs, key: "campaign" }), otherWs);
    expect(other.items.map((i) => i.code)).toEqual(["Other_WS_Campaign"]);
    // Asking for another workspace's id under this workspace's context reads nothing (RLS).
    const cross = await asApp((tx) => listFactDimensionValues(tx, { workspaceId: otherWs, key: "campaign" }));
    expect(cross.total).toBe(0);
  });
});
