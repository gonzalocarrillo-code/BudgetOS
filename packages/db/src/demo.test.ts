import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import { afterAll, describe, expect, it } from "vitest";
import { campaignFactsForLeaves, campaignsForLeaf, purgeDemoData, reseedCampaignDemoData, seedDemoData, type CampaignLeafInput } from "./demo.js";
import { asOrgAdmin } from "./tenant.js";

/**
 * EX-3 (docs/adr/0087-campaign-demo-data.md): demo workspaces get realistic campaign-level data so
 * campaign-vs-campaign experiments can be used fully. §1 pure-function tests cover the generator's
 * properties directly (no-data days, the mid-period start); §2 covers seedDemoData, the
 * POST /workspaces/:ws/demo-data/campaigns reseed path and purgeDemoData end to end against Postgres.
 */

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
function loadEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const sep = trimmed.indexOf("=");
    if (sep === -1) continue;
    const key = trimmed.slice(0, sep).trim();
    let value = trimmed.slice(sep + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnv(join(packageRoot, ".env"));
const ownerUrl = process.env["DATABASE_URL"] ?? "postgresql://budget:budget@localhost:5432/budget";
const prisma = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
afterAll(() => prisma.$disconnect());

// ---- §1: campaignFactsForLeaves / campaignsForLeaf (pure, deterministic) -----------------------

describe("campaignsForLeaf (EX-3)", () => {
  it("2-4 realistic, distinctly-named campaigns, deterministic across calls", () => {
    const leaf = { id: "leaf-br-meta", tuple: { country: "BR", platform: "meta" } };
    const a = campaignsForLeaf(leaf, "ws1");
    const b = campaignsForLeaf(leaf, "ws1");
    expect(a.length).toBeGreaterThanOrEqual(2);
    expect(a.length).toBeLessThanOrEqual(4);
    expect(a).toEqual(b);
    expect(new Set(a.map((c) => c.code)).size).toBe(a.length);
    for (const c of a) {
      expect(c.label).toMatch(/^BR_Meta_[A-Za-z]+_Q4_[A-Za-z0-9]+$/);
      expect(c.code.startsWith("ws1_")).toBe(true);
    }
    // Different workspaces never collide on the (org-wide) dimension's unique (dimension_id, code).
    const c = campaignsForLeaf(leaf, "ws2");
    expect(a.map((x) => x.code)).not.toEqual(c.map((x) => x.code));
  });
});

describe("campaignFactsForLeaves (EX-3)", () => {
  const leaves: CampaignLeafInput[] = [
    { id: "leaf-0", tuple: { country: "BR", platform: "meta" }, amount: new Decimal("18000"), index: 0 },
    { id: "leaf-1", tuple: { country: "MX", platform: "google_ads" }, amount: new Decimal("22000"), index: 1 },
  ];

  it("writes daily, campaign-tagged facts with impressions/clicks/conversions/revenue, and some days have no row at all (never a zero row)", () => {
    const { spend, kpi, campaignsByLeaf } = campaignFactsForLeaves(leaves, "wstest", 2026, 1, "2026-01-01", "2026-04-10", "run-1", "USD");
    expect(spend.length).toBeGreaterThan(0);
    for (const row of spend) {
      expect(new Decimal(row.amount).gt(0)).toBe(true);
      expect((row.dimensionValues as Record<string, string>)["campaign"]).toBeTruthy();
    }
    const metrics = new Set(kpi.map((k) => k.metric));
    expect(metrics).toEqual(new Set(["conversions", "impressions", "clicks", "revenue"]));
    for (const row of kpi) expect(new Decimal(row.value).gte(0)).toBe(true);

    // No-data days: at least one (leaf, campaign) combination is missing at least one day within its
    // own active window — never present as an explicit zero-amount row (every row above is > 0).
    const campaigns = campaignsByLeaf.get("leaf-0") ?? [];
    expect(campaigns.length).toBeGreaterThanOrEqual(2);
    const byCode = new Map(campaigns.map((c) => [c.code, new Set(spend.filter((s) => (s.dimensionValues as Record<string, string>)["campaign"] === c.code).map((s) => s.periodDate))]));
    const totalDays = 100; // 2026-01-01..2026-04-10
    const anyGap = [...byCode.values()].some((days) => days.size > 0 && days.size < totalDays);
    expect(anyGap).toBe(true);
  });

  it("exactly one campaign (the first leaf's last) starts mid-period: no facts for it before the midpoint", () => {
    const { spend, campaignsByLeaf } = campaignFactsForLeaves(leaves, "wstest", 2026, 1, "2026-01-01", "2026-04-10", "run-mid", "USD");
    const campaigns = campaignsByLeaf.get("leaf-0") ?? [];
    const midStart = campaigns.at(-1) as { code: string };
    const midStartDays = spend.filter((s) => (s.dimensionValues as Record<string, string>)["campaign"] === midStart.code).map((s) => s.periodDate).sort();
    expect(midStartDays.length).toBeGreaterThan(0);
    expect(midStartDays[0]).not.toBe("2026-01-01"); // did not run from day 1
    // Every other leaf-0 campaign has at least one row on day 1 (nothing else was held back).
    const others = campaigns.slice(0, -1);
    for (const c of others) {
      const hasDayOne = spend.some((s) => (s.dimensionValues as Record<string, string>)["campaign"] === c.code && s.periodDate === "2026-01-01");
      expect(hasDayOne || campaigns.length === 1).toBe(true);
    }
  });

  it("per leaf, the total over a fully-elapsed month stays close to the old monthly-plan total (85-105% of plan/12), within a documented tolerance for jitter and no-data days", () => {
    // A window of exactly one full closed month (Jan) plus nothing partial, so the comparison is exact.
    const { spend } = campaignFactsForLeaves([leaves[0] as CampaignLeafInput], "wstest", 2026, 1, "2026-01-01", "2026-01-31", "run-close", "USD");
    const total = spend.reduce((s, r) => s.plus(r.amount), new Decimal(0));
    const pct = new Decimal(85 + (0 * 13) % 21).div(100); // leaf.index=0, month n=0, same formula as demo.ts
    const monthlyPlan = (leaves[0] as CampaignLeafInput).amount.div(12).mul(pct);
    const ratio = total.div(monthlyPlan);
    expect(ratio.gte("0.8")).toBe(true);
    expect(ratio.lte("1.2")).toBe(true);
  });
});

// ---- §2: seedDemoData / reseedCampaignDemoData / purgeDemoData (Postgres) -----------------------

async function seedRegistry(orgId: string): Promise<void> {
  const dims: Array<{ key: string; values: string[] }> = [
    { key: "region", values: ["AMER", "LATAM"] },
    { key: "country", values: ["BR", "MX", "US"] },
    { key: "platform", values: ["meta", "google_ads"] },
    { key: "objective", values: ["conversion"] },
    { key: "audience", values: ["prospecting"] },
  ];
  await asOrgAdmin(
    prisma,
    async (tx) => {
      for (const d of dims) {
        const dimId = randomUUID();
        await tx.$executeRawUnsafe(
          `INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by) VALUES ($1::uuid, $2::uuid, NULL, $3, $3, 'TEXT', $4::uuid)`,
          dimId,
          orgId,
          d.key,
          randomUUID(),
        );
        for (const code of d.values) {
          await tx.$executeRawUnsafe(`INSERT INTO dimension_value (id, dimension_id, code, label) VALUES ($1::uuid, $2::uuid, $3, $3)`, randomUUID(), dimId, code);
        }
      }
    },
    orgId,
  );
}

describe("seedDemoData / reseedCampaignDemoData / purgeDemoData (EX-3, Postgres)", () => {
  it("seeds campaign-level daily facts and one RUNNING demo experiment; reseed on a fresh workspace is a no-op; purge removes everything including the experiment", async () => {
    const orgId = randomUUID();
    const workspaceId = randomUUID();
    const createdBy = randomUUID();
    const today = "2026-01-10"; // fiscalYearStartMonth=1 -> a short, fast window (Jan 1..Jan 9)

    await prisma.$executeRaw`INSERT INTO organization (id, name) VALUES (${orgId}::uuid, 'ex3-test')`;
    await asOrgAdmin(prisma, (tx) => tx.$executeRaw`INSERT INTO workspace (id, org_id, slug, name, reporting_currency, fiscal_year_start_month) VALUES (${workspaceId}::uuid, ${orgId}::uuid, ${`ex3-${workspaceId}`}, 'EX3', 'USD', 1)`, orgId);
    await seedRegistry(orgId);

    const ctx = { workspaceId, orgId, createdBy, reportingCurrency: "USD", fiscalYearStartMonth: 1, today };
    const summary = await asOrgAdmin(prisma, (tx) => seedDemoData(tx, ctx, () => randomUUID()), orgId);

    expect(summary.envelopes).toBe(9);
    expect(summary.leaves).toBe(6);
    expect(summary.targets).toBe(3);
    expect(summary.campaigns).toBeGreaterThanOrEqual(12); // >= 2 campaigns * 6 leaves
    expect(summary.experiments).toBe(1);
    expect(summary.facts).toBeGreaterThan(0);

    const [experiment] = await asOrgAdmin(
      prisma,
      (tx) => tx.$queryRaw<Array<{ status: string; demo: boolean; test_scope_filter: unknown }>>`SELECT status, demo, test_scope_filter FROM experiment WHERE workspace_id = ${workspaceId}::uuid`,
      orgId,
    );
    expect(experiment?.status).toBe("RUNNING");
    expect(experiment?.demo).toBe(true);
    expect(JSON.stringify(experiment?.test_scope_filter)).toContain("campaign");

    const campaignFacts = await asOrgAdmin(
      prisma,
      (tx) => tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM spend_fact WHERE workspace_id = ${workspaceId}::uuid AND demo AND dimension_values ? 'campaign'`,
      orgId,
    );
    expect(Number(campaignFacts[0]?.n ?? 0)).toBeGreaterThan(0);

    // Reseed is idempotent: a workspace that already has campaign facts changes nothing.
    const reseed1 = await asOrgAdmin(prisma, (tx) => reseedCampaignDemoData(tx, { workspaceId, orgId, createdBy, today }, () => randomUUID()), orgId);
    expect(reseed1.alreadyPresent).toBe(true);
    expect(reseed1.facts).toBe(0);
    expect(reseed1.supersededFacts).toBe(0);

    const purged = await asOrgAdmin(prisma, (tx) => purgeDemoData(tx, workspaceId), orgId);
    expect(purged.envelopes).toBe(9);
    expect(purged.targets).toBe(3);
    expect(purged.experiments).toBe(1);
    const left = await asOrgAdmin(prisma, (tx) => tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM spend_fact WHERE workspace_id = ${workspaceId}::uuid`, orgId);
    expect(left).toEqual([{ n: 0n }]);
    const expLeft = await asOrgAdmin(prisma, (tx) => tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM experiment WHERE workspace_id = ${workspaceId}::uuid`, orgId);
    expect(expLeft).toEqual([{ n: 0n }]);

    await asOrgAdmin(prisma, (tx) => tx.$executeRaw`DELETE FROM workspace WHERE id = ${workspaceId}::uuid`, orgId);
    await prisma.$executeRaw`DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = ${orgId}::uuid)`;
    await prisma.$executeRaw`DELETE FROM dimension WHERE org_id = ${orgId}::uuid`;
    await prisma.$executeRaw`DELETE FROM organization WHERE id = ${orgId}::uuid`;
  }, 30_000);

  it("reseed adds campaign data to a workspace with only the old leaf-level monthly demo facts, and supersedes (never deletes) those old facts so totals don't double", async () => {
    const orgId = randomUUID();
    const workspaceId = randomUUID();
    const createdBy = randomUUID();
    const parentId = randomUUID();
    const envelopeId = randomUUID();
    const versionId = randomUUID();
    const today = "2026-01-10";

    await prisma.$executeRaw`INSERT INTO organization (id, name) VALUES (${orgId}::uuid, 'ex3-reseed-test')`;
    await asOrgAdmin(prisma, (tx) => tx.$executeRaw`INSERT INTO workspace (id, org_id, slug, name, reporting_currency, fiscal_year_start_month) VALUES (${workspaceId}::uuid, ${orgId}::uuid, ${`ex3r-${workspaceId}`}, 'EX3R', 'USD', 1)`, orgId);
    await seedRegistry(orgId);

    // The pre-EX-3 shape: a market parent + one leaf envelope with a single old-style monthly demo
    // fact (no campaign key). reseedCampaignDemoData only generates campaigns for leaves (parentId
    // not null): the parent's own rollup tuple never carries facts directly.
    const parentTuple = { country: "BR" };
    const tuple = { country: "BR", platform: "meta", objective: "conversion", audience: "prospecting" };
    await asOrgAdmin(
      prisma,
      async (tx) => {
        await tx.$executeRaw`INSERT INTO envelope (id, workspace_id, name, dimension_values, start_date, end_date, currency, status, created_by, demo, updated_at)
          VALUES (${parentId}::uuid, ${workspaceId}::uuid, 'Brazil (demo)', ${JSON.stringify(parentTuple)}::jsonb, '2026-01-01', '2026-12-31', 'USD', 'APPROVED', ${createdBy}::uuid, true, now())`;
        await tx.$executeRaw`INSERT INTO envelope (id, workspace_id, parent_id, name, dimension_values, start_date, end_date, currency, status, created_by, demo, updated_at)
          VALUES (${envelopeId}::uuid, ${workspaceId}::uuid, ${parentId}::uuid, 'BR Meta (demo)', ${JSON.stringify(tuple)}::jsonb, '2026-01-01', '2026-12-31', 'USD', 'APPROVED', ${createdBy}::uuid, true, now())`;
        await tx.$executeRaw`INSERT INTO envelope_version (id, envelope_id, version_no, amount, amount_reporting, status, created_by, approved_at, demo)
          VALUES (${versionId}::uuid, ${envelopeId}::uuid, 1, '18000.00', '18000.00', 'APPROVED', ${createdBy}::uuid, now(), true)`;
        await tx.$executeRaw`UPDATE envelope SET current_version_id = ${versionId}::uuid WHERE id = ${envelopeId}::uuid`;
        await tx.$executeRaw`SELECT ensure_fact_partitions('2026-01-01'::date, 1)`;
        await tx.$executeRaw`INSERT INTO spend_fact (workspace_id, dimension_values, period_date, currency, amount, amount_reporting, source_system, source_run_id, source_row_hash, natural_key, demo, envelope_id, match_method)
          VALUES (${workspaceId}::uuid, ${JSON.stringify(tuple)}::jsonb, '2026-01-01', 'USD', '1500.00', '1500.00', 'demo', ${randomUUID()}::uuid, 'old-monthly-1', 'old-monthly-1', true, ${envelopeId}::uuid, 'tuple')`;
      },
      orgId,
    );

    const before = await asOrgAdmin(prisma, (tx) => tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM spend_fact WHERE workspace_id = ${workspaceId}::uuid AND superseded_at IS NULL`, orgId);
    expect(Number(before[0]?.n)).toBe(1);

    const result = await asOrgAdmin(prisma, (tx) => reseedCampaignDemoData(tx, { workspaceId, orgId, createdBy, today }, () => randomUUID()), orgId);
    expect(result.alreadyPresent).toBe(false);
    expect(result.campaigns).toBeGreaterThanOrEqual(2);
    expect(result.facts).toBeGreaterThan(0);
    expect(result.supersededFacts).toBe(1); // the old monthly row, never deleted

    const live = await asOrgAdmin(
      prisma,
      (tx) => tx.$queryRaw<Array<{ n: bigint; has_campaign: boolean }>>`
        SELECT count(*) AS n, bool_and(dimension_values ? 'campaign') AS has_campaign FROM (
          SELECT dimension_values FROM spend_fact WHERE workspace_id = ${workspaceId}::uuid AND superseded_at IS NULL
          UNION ALL
          SELECT dimension_values FROM kpi_fact WHERE workspace_id = ${workspaceId}::uuid AND superseded_at IS NULL
        ) f`,
      orgId,
    );
    expect(Number(live[0]?.n)).toBe(result.facts);
    expect(live[0]?.has_campaign).toBe(true);
    const oldRow = await asOrgAdmin(prisma, (tx) => tx.$queryRaw<Array<{ superseded_at: Date | null }>>`SELECT superseded_at FROM spend_fact WHERE natural_key = 'old-monthly-1'`, orgId);
    expect(oldRow[0]?.superseded_at).not.toBeNull(); // superseded, not deleted (ADR-071)

    // Idempotent: calling it again now changes nothing.
    const again = await asOrgAdmin(prisma, (tx) => reseedCampaignDemoData(tx, { workspaceId, orgId, createdBy, today }, () => randomUUID()), orgId);
    expect(again.alreadyPresent).toBe(true);

    await asOrgAdmin(prisma, (tx) => purgeDemoData(tx, workspaceId), orgId);
    await asOrgAdmin(prisma, (tx) => tx.$executeRaw`DELETE FROM workspace WHERE id = ${workspaceId}::uuid`, orgId);
    await prisma.$executeRaw`DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = ${orgId}::uuid)`;
    await prisma.$executeRaw`DELETE FROM dimension WHERE org_id = ${orgId}::uuid`;
    await prisma.$executeRaw`DELETE FROM organization WHERE id = ${orgId}::uuid`;
  }, 30_000);
});
