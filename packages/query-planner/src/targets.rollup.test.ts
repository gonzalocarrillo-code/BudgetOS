import { randomUUID } from "node:crypto";
import { QueryRequest, type FilterGroupT } from "@budget/domain";
import { Decimal } from "decimal.js";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileQuery, compileTotals, type CompileOptions, type FilterTarget, type MetricDef } from "./index.js";
import { closePools, owner, runAsApp, type Row } from "./test-support/db.js";
import { PERIOD, TODAY, cleanupOrg, createOrg, createWorkspace, insertEnvelope, type FixtureOrg } from "./test-support/fixtures.js";

/**
 * T-015 done-when: CPA roll-up equals spend / conversions at every level. KPIs are Σnumerator /
 * Σdenominator per group and in totals, never an average of leaf ratios. Facts are SQL fixtures
 * (spend_fact + kpi_fact); the golden seed has no facts until T-017.
 */

const METRICS = new Map<string, MetricDef>([
  ["cpa", { numerator: "spend", denominator: "kpi:conversions" }],
  ["roas", { numerator: "kpi:revenue", denominator: "spend" }],
  ["cpm", { numerator: "spend", denominator: "kpi:impressions", multiplier: "1000" }],
  ["conversions", { numerator: "kpi:conversions", denominator: null }],
]);

interface Leaf {
  geo: string;
  platform: string;
  spend: string;
  conversions: string | null; // null = no kpi_fact row at all
  revenue?: string;
  impressions?: string;
}

let org: FixtureOrg;

beforeAll(async () => {
  org = await createOrg();
});

afterAll(async () => {
  if (org) await cleanupOrg(org);
  await closePools();
});

const request = (workspaceId: string, over: Record<string, unknown> = {}) =>
  QueryRequest.parse({ workspaceId, period: { kind: "range", ...PERIOD }, measures: ["budget", "actual"], limit: 1000, ...over });
const run = (workspaceId: string, over: Record<string, unknown>, opts: CompileOptions = { metrics: METRICS }) =>
  runAsApp(compileQuery(request(workspaceId, over), PERIOD, TODAY, opts), { workspaceId, userId: org.users.u1 });
const totals = async (workspaceId: string, over: Record<string, unknown>, opts: CompileOptions = { metrics: METRICS }) =>
  (await runAsApp(compileTotals(request(workspaceId, over), PERIOD, TODAY, opts), { workspaceId, userId: org.users.u1 }))[0] as Row;

async function seedLeaves(leaves: Leaf[]): Promise<string> {
  const ws = await createWorkspace(org);
  for (const [i, l] of leaves.entries()) {
    const kpi = [
      ...(l.conversions === null ? [] : [{ date: "2026-01-15", metric: "conversions", value: l.conversions }]),
      ...(l.revenue ? [{ date: "2026-01-15", metric: "revenue", value: l.revenue }] : []),
      ...(l.impressions ? [{ date: "2026-02-15", metric: "impressions", value: l.impressions }] : []),
    ];
    await insertEnvelope(org, ws, {
      name: `leaf-${i}`,
      geo: l.geo,
      platform: l.platform,
      status: "APPROVED",
      start: PERIOD.start,
      end: PERIOD.end,
      versions: [{ amount: "10000.00", status: "APPROVED", approvedAt: "2026-01-02T00:00:00Z" }],
      spend: [{ date: "2026-01-15", amount: l.spend }],
      kpi,
    });
  }
  return ws;
}

/** Σnumerator / Σdenominator over some leaves, in Decimal; null when the denominator sums to zero. */
function ratio(leaves: Leaf[], num: (l: Leaf) => string | null | undefined, den: (l: Leaf) => string | null | undefined, mult = "1"): Decimal | null {
  const sum = (f: (l: Leaf) => string | null | undefined) => leaves.reduce((s, l) => s.plus(f(l) ?? 0), new Decimal(0));
  const d = sum(den);
  return d.isZero() ? null : sum(num).mul(mult).div(d);
}
const expectedCpa = (leaves: Leaf[]) => ratio(leaves, (l) => l.spend, (l) => l.conversions);

function close(actual: unknown, expected: Decimal | null): boolean {
  if (expected === null) return actual === null;
  if (actual === null || actual === undefined) return false;
  const a = new Decimal(String(actual));
  return a.minus(expected).abs().lte(expected.abs().plus(1).mul("1e-12"));
}

const keyOf = (r: Row, groupBy: string[]) => groupBy.map((k) => String(r[`dim_${k}`])).join("|");
const groupsOf = (leaves: Leaf[], groupBy: string[]) => {
  const out = new Map<string, Leaf[]>();
  for (const l of leaves) {
    const k = groupBy.map((g) => (g === "geo" ? l.geo : l.platform)).join("|");
    out.set(k, [...(out.get(k) ?? []), l]);
  }
  return out;
};

async function assertEveryLevel(ws: string, leaves: Leaf[]): Promise<void> {
  const levels = [[], ["geo"], ["platform"], ["geo", "platform"], ["platform", "geo"]];
  for (const groupBy of levels) {
    if (groupBy.length === 0) {
      const flat = await run(ws, { targets: ["cpa"] });
      expect(flat).toHaveLength(leaves.length);
      for (const r of flat) {
        const leaf = leaves[Number(String(r["name"]).slice(5))] as Leaf;
        expect(close(r["kpi_cpa"], expectedCpa([leaf])), `leaf ${String(r["name"])}: ${String(r["kpi_cpa"])}`).toBe(true);
      }
      continue;
    }
    const rows = await run(ws, { groupBy, targets: ["cpa"] });
    const expected = groupsOf(leaves, groupBy);
    expect(rows).toHaveLength(expected.size);
    for (const r of rows) {
      const group = expected.get(keyOf(r, groupBy)) ?? [];
      expect(close(r["kpi_cpa"], expectedCpa(group)), `${groupBy.join(">")} ${keyOf(r, groupBy)}: ${String(r["kpi_cpa"])} vs ${String(expectedCpa(group))}`).toBe(true);
    }
  }
  const t = await totals(ws, { targets: ["cpa"] });
  expect(close(t["kpi_cpa"], expectedCpa(leaves)), `totals ${String(t["kpi_cpa"])}`).toBe(true);
}

describe("T-015: CPA roll-up = spend / conversions at every level", () => {
  // Brazil: leaf CPAs are 10 and 1000 (mean 505); the roll-up is (100 + 1000) / (10 + 1) = 100.
  const LEAVES: Leaf[] = [
    { geo: "br", platform: "meta", spend: "100.00", conversions: "10", revenue: "400.00", impressions: "20000" },
    { geo: "br", platform: "google", spend: "1000.00", conversions: "1", revenue: "900.00", impressions: "50000" },
    { geo: "mx", platform: "meta", spend: "333.33", conversions: "7", revenue: "0", impressions: "1" },
    { geo: "mx", platform: "google", spend: "250.00", conversions: "0" }, // spend, zero conversions
    { geo: "de", platform: "meta", spend: "0.00", conversions: null }, // no KPI facts
    { geo: "de", platform: "tiktok", spend: "80.10", conversions: "3" },
  ];
  let ws: string;
  beforeAll(async () => {
    ws = await seedLeaves(LEAVES);
  });

  it("divides sums per group, per nested group, and in totals — never averages leaf CPAs", async () => {
    await assertEveryLevel(ws, LEAVES);
    const br = (await run(ws, { groupBy: ["geo"], targets: ["cpa"] })).find((r) => r["dim_geo"] === "br");
    expect(new Decimal(String(br?.["kpi_cpa"])).toFixed(2)).toBe("100.00");
    const meanOfLeaves = new Decimal(10).plus(1000).div(2);
    expect(new Decimal(String(br?.["kpi_cpa"])).equals(meanOfLeaves)).toBe(false);
  });

  it("is NULL where the group has no conversions, and counts spend with no KPI rows in the numerator", async () => {
    const byGeo = new Map((await run(ws, { groupBy: ["geo", "platform"], targets: ["cpa"] })).map((r) => [keyOf(r, ["geo", "platform"]), r]));
    expect(byGeo.get("mx|google")?.["kpi_cpa"]).toBeNull();
    expect(byGeo.get("de|meta")?.["kpi_cpa"]).toBeNull();
    // mx: (333.33 + 250) / 7 — the zero-conversion leaf's spend still counts.
    const mx = (await run(ws, { groupBy: ["geo"], targets: ["cpa"] })).find((r) => r["dim_geo"] === "mx");
    expect(close(mx?.["kpi_cpa"], new Decimal("583.33").div(7))).toBe(true);
  });

  it("applies the same rule to every metric shape: inverse ratio (ROAS), multiplier (CPM), plain sums", async () => {
    const rows = await run(ws, { groupBy: ["platform"], targets: ["roas", "cpm", "conversions"] });
    for (const r of rows) {
      const group = groupsOf(LEAVES, ["platform"]).get(String(r["dim_platform"])) ?? [];
      expect(close(r["kpi_roas"], ratio(group, (l) => l.revenue, (l) => l.spend))).toBe(true);
      expect(close(r["kpi_cpm"], ratio(group, (l) => l.spend, (l) => l.impressions, "1000"))).toBe(true);
      expect(close(r["kpi_conversions"], group.reduce((s, l) => s.plus(l.conversions ?? 0), new Decimal(0)))).toBe(true);
    }
    const t = await totals(ws, { targets: ["cpm"] });
    expect(close(t["kpi_cpm"], ratio(LEAVES, (l) => l.spend, (l) => l.impressions, "1000"))).toBe(true);
  });

  it("sorts groups by the rolled-up KPI", async () => {
    const rows = await run(ws, { groupBy: ["geo"], targets: ["cpa"], sort: [{ key: "kpi_cpa", dir: "desc" }] });
    const values = rows.map((r) => (r["kpi_cpa"] === null ? null : new Decimal(String(r["kpi_cpa"]))));
    const nonNull = values.filter((v): v is Decimal => v !== null);
    expect(nonNull.map((v) => v.toFixed(4))).toEqual([...nonNull].sort((a, b) => b.comparedTo(a)).map((v) => v.toFixed(4)));
  });

  it("property: for random leaves and facts, every level equals Σspend / Σconversions", async () => {
    const leaf = fc.record({
      geo: fc.constantFrom("br", "mx", "de"),
      platform: fc.constantFrom("meta", "google", "tiktok"),
      spend: fc.integer({ min: 0, max: 5_000_000 }).map((c) => new Decimal(c).div(100).toFixed(2)),
      conversions: fc.option(fc.integer({ min: 0, max: 900 }).map(String), { nil: null }),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(leaf, { minLength: 1, maxLength: 8 }), async (leaves) => {
        const pws = await seedLeaves(leaves);
        await assertEveryLevel(pws, leaves);
      }),
      { numRuns: 15, seed: 20260924 },
    );
  }, 120_000);
});

describe("T-015: targets[] on rows (effective_target, then filter-scoped targets)", () => {
  let ws: string;
  const ids: Record<string, string> = {};

  async function target(envelopeId: string | null, metric: string, value: string, scope: FilterGroupT | null = null): Promise<string> {
    const t = randomUUID();
    const v = randomUUID();
    await owner.query(
      `INSERT INTO target (id, workspace_id, scope_type, envelope_id, scope_filter, metric_key, start_date, end_date)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
      [t, ws, envelopeId ? "envelope" : "filter", envelopeId, scope ? JSON.stringify(scope) : null, metric, PERIOD.start, PERIOD.end],
    );
    await owner.query(
      `INSERT INTO target_version (id, target_id, version_no, value, comparator, status, created_by, approved_at)
       VALUES ($1, $2, 1, $3, 'lte', 'APPROVED', $4, '2026-01-02T00:00:00Z')`,
      [v, t, value, org.users.u1],
    );
    await owner.query(`UPDATE target SET current_version_id = $2 WHERE id = $1`, [t, v]);
    return t;
  }

  beforeAll(async () => {
    ws = await createWorkspace(org);
    const base = { status: "APPROVED" as const, start: PERIOD.start, end: PERIOD.end, versions: [{ amount: "1000.00", status: "APPROVED" as const, approvedAt: "2026-01-02T00:00:00Z" }] };
    const parent = await insertEnvelope(org, ws, { ...base, name: "LATAM", geo: "latam", versions: [{ amount: "5000.00", status: "APPROVED", approvedAt: "2026-01-02T00:00:00Z" }] });
    ids["parent"] = parent.id;
    ids["inherits"] = (await insertEnvelope(org, ws, { ...base, name: "BR", geo: "br", platform: "meta", parentId: parent.id, spend: [{ date: "2026-01-10", amount: "300.00" }], kpi: [{ date: "2026-01-10", metric: "conversions", value: "12" }] })).id;
    ids["overrides"] = (await insertEnvelope(org, ws, { ...base, name: "MX", geo: "mx", platform: "meta", parentId: parent.id, spend: [{ date: "2026-01-10", amount: "100.00" }], kpi: [{ date: "2026-01-10", metric: "conversions", value: "10" }] })).id;
    ids["filtered"] = (await insertEnvelope(org, ws, { ...base, name: "DE", geo: "de", platform: "tiktok", spend: [{ date: "2026-01-10", amount: "90.00" }], kpi: [{ date: "2026-01-10", metric: "conversions", value: "3" }] })).id;
    ids["none"] = (await insertEnvelope(org, ws, { ...base, name: "Unscoped", platform: "google" })).id;
    await target(ids["parent"] as string, "cpa", "20");
    await target(ids["overrides"] as string, "cpa", "15");
  });

  const filterTargets: FilterTarget[] = [
    { metricKey: "cpa", value: "40", scope: { logic: "and", children: [{ field: { kind: "dimension", key: "geo" }, op: "eq", value: "de" }, { field: { kind: "dimension", key: "platform" }, op: "eq", value: "tiktok" }] } },
    { metricKey: "cpa", value: "35", scope: { logic: "and", children: [{ field: { kind: "dimension", key: "geo" }, op: "descends_from", value: "emea" }] } },
    { metricKey: "cpa", value: "99", scope: { logic: "and", children: [{ field: { kind: "dimension", key: "geo" }, op: "in", value: ["br", "mx"] }] } },
  ];
  const byName = async (opts: CompileOptions, over: Record<string, unknown> = {}) =>
    new Map((await run(ws, { targets: ["cpa"], ...over }, opts)).map((r) => [String(r["name"]), r]));

  it("children inherit the parent's target unless they override it; vs_<metric> = actual / target", async () => {
    const rows = await byName({ metrics: METRICS });
    expect(new Decimal(String(rows.get("BR")?.["tgt_cpa"])).toFixed(2)).toBe("20.00");
    expect(new Decimal(String(rows.get("MX")?.["tgt_cpa"])).toFixed(2)).toBe("15.00");
    expect(new Decimal(String(rows.get("LATAM")?.["tgt_cpa"])).toFixed(2)).toBe("20.00");
    expect(rows.get("DE")?.["tgt_cpa"]).toBeNull();
    expect(new Decimal(String(rows.get("BR")?.["kpi_cpa"])).toFixed(2)).toBe("25.00");
    expect(new Decimal(String(rows.get("BR")?.["vs_cpa"])).toFixed(4)).toBe("1.2500");
    expect(new Decimal(String(rows.get("MX")?.["vs_cpa"])).toFixed(4)).toBe("0.6667");
  });

  it("filter-scoped targets apply only where no envelope target exists, first match wins", async () => {
    const rows = await byName({ metrics: METRICS, filterTargets });
    expect(new Decimal(String(rows.get("DE")?.["tgt_cpa"])).toFixed(2)).toBe("40.00");
    // BR / MX have envelope targets (own or inherited): the geo in [br, mx] filter target never applies.
    expect(new Decimal(String(rows.get("BR")?.["tgt_cpa"])).toFixed(2)).toBe("20.00");
    expect(new Decimal(String(rows.get("MX")?.["tgt_cpa"])).toFixed(2)).toBe("15.00");
    expect(rows.get("Unscoped")?.["tgt_cpa"]).toBeNull();
    const reordered = await byName({ metrics: METRICS, filterTargets: [filterTargets[1] as FilterTarget, filterTargets[0] as FilterTarget] });
    expect(new Decimal(String(reordered.get("DE")?.["tgt_cpa"])).toFixed(2)).toBe("35.00");
  });

  it("target predicates in the filter read the same resolved target (inherited and filter-scoped)", async () => {
    const f = (value: number): FilterGroupT => ({ logic: "and", children: [{ field: { kind: "target", metric: "cpa", field: "value" }, op: "gte", value }] });
    const names = async (filter: FilterGroupT) => [...(await byName({ metrics: METRICS, filterTargets }, { filter })).keys()].sort();
    expect(await names(f(20))).toEqual(["BR", "DE", "LATAM"]);
    expect(await names(f(16))).toEqual(["BR", "DE", "LATAM"]);
    expect(await names(f(1))).toEqual(["BR", "DE", "LATAM", "MX"]);
    const over: FilterGroupT = { logic: "and", children: [{ field: { kind: "target", metric: "cpa", field: "vs_target_pct" }, op: "gt", value: 1 }] };
    expect(await names(over)).toEqual(["BR"]);
  });

  it("sorts by the target and the vs column", async () => {
    const rows = await run(ws, { targets: ["cpa"], sort: [{ key: "vs_cpa", dir: "asc" }] }, { metrics: METRICS, filterTargets });
    expect(rows.map((r) => r["name"]).slice(0, 3)).toEqual(["MX", "DE", "BR"]);
  });
});
