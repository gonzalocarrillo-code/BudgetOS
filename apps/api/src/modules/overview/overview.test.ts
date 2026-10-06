import { randomUUID } from "node:crypto";
import { LIVE_LEAVES, TOP_LEVEL, elapsedFraction } from "@budget/domain";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGolden, type GoldenResult } from "../../seed/golden.js";
import { appDb as appDbClient, ownerDb, startHarness, testUser, type Harness } from "../../test-support/harness.js";
import { cleanupGolden } from "../../test-support/golden-cleanup.js";
import { perfBudgetMs } from "../../test-support/perf.js";

/**
 * T-033 (Epic 1.11): the Overview in one call on the golden workspace. The heatmap's cells add up
 * to the live-leaf totals the Explorer shows; variances are the largest over and under; alerts and
 * approvals are the caller's; freshness names the last fact date. It answers well inside 1.5 s.
 */

const owner = ownerDb();
const app = appDbClient();
let h: Harness;
let golden: GoldenResult;
const slug = `overview-${randomUUID().slice(0, 8)}`;

type Body = Record<string, unknown>;
async function as(persona: string, method: "GET" | "POST" | "PATCH", url: string, body?: unknown) {
  const token = await h.mint({ sub: `ip-${persona}`, email: `${persona.toLowerCase()}@${slug}.golden.test` }, { googleSub: `golden-${slug}-${persona}` });
  return h.call(method, url, token, { headers: { "x-workspace-id": golden.workspaceId }, ...(body === undefined ? {} : { body }) });
}

beforeAll(async () => {
  golden = await seedGolden(app, owner, { slug });
  h = await startHarness();
}, 180_000);

afterAll(async () => {
  await h?.close();
  if (golden?.created) await cleanupGolden(owner, golden);
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("GET /workspaces/:ws/overview (T-033)", () => {
  it("heatmap cells add up to the live-leaf totals; country × platform with labels", async () => {
    const res = await as("planner", "GET", `/api/v1/workspaces/${golden.workspaceId}/overview`);
    expect(res.status, JSON.stringify(res.body).slice(0, 500)).toBe(200);
    const o = res.body as Body & { heatmap: { rowDimension: { key: string }; colDimension: { key: string }; rows: string[]; cols: string[]; labels: { rows: Record<string, string> }; cells: Array<{ row: string; col: string; budget: string }> }; totals: Record<string, string> };
    expect([o.heatmap.rowDimension.key, o.heatmap.colDimension.key]).toEqual(["country", "platform"]);
    expect(o.heatmap.rows).toEqual(expect.arrayContaining(["BR", "MX"]));
    expect(o.heatmap.cols).toEqual(expect.arrayContaining(["meta", "google_ads"]));
    expect(o.heatmap.labels.rows["BR"]).toBe("Brazil");
    const sum = o.heatmap.cells.reduce((s, c) => s.plus(c.budget ?? 0), new Decimal(0));
    expect(sum.toFixed(2)).toBe(new Decimal(o.totals["budget"] ?? 0).toFixed(2));
    const q = await as("planner", "POST", `/api/v1/workspaces/${golden.workspaceId}/query`, { workspaceId: golden.workspaceId, period: { kind: "relative", preset: "current_year" }, filter: { logic: "and", children: LIVE_LEAVES }, measures: ["budget"], limit: 1 });
    expect(o.totals["budget"]).toBe((q.body["totals"] as Record<string, string>)["budget"]);
    // UX-008 (ADR-051): the tiles read Budgets' total (top-level budgets with their subtree's
    // spend); `assigned` is the leaves' total the heatmap adds up to.
    const top = await as("planner", "POST", `/api/v1/workspaces/${golden.workspaceId}/query`, { workspaceId: golden.workspaceId, period: { kind: "relative", preset: "current_year" }, filter: { logic: "and", children: TOP_LEVEL }, subtree: true, measures: ["budget", "actual"], limit: 1 });
    const head = (res.body as { headline: Record<string, string> }).headline;
    expect(head).toMatchObject({ basis: "top_level", budget: (top.body["totals"] as Record<string, string>)["budget"], actual: (top.body["totals"] as Record<string, string>)["actual"], assigned: o.totals["budget"] });
  });

  it("the heatmap's axes are any two granularities the caller picks; every column comes back (product feedback 8)", async () => {
    const res = await as("planner", "GET", `/api/v1/workspaces/${golden.workspaceId}/overview?rows=region&cols=objective`);
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    const o = res.body as Body & { heatmap: { rowDimension: { key: string }; colDimension: { key: string }; cols: string[]; cells: Array<{ budget: string; spend_to_date_pct: string | null }>; dimensions: Array<{ key: string }> }; totals: Record<string, string>; period: { elapsed: string } };
    expect([o.heatmap.rowDimension.key, o.heatmap.colDimension.key]).toEqual(["region", "objective"]);
    expect(o.heatmap.dimensions.map((d) => d.key)).toEqual(expect.arrayContaining(["country", "platform", "region", "objective"]));
    expect(o.heatmap.cells.every((c) => c.spend_to_date_pct !== undefined)).toBe(true);
    const sum = o.heatmap.cells.reduce((s, c) => s.plus(c.budget ?? 0), new Decimal(0));
    expect(sum.toFixed(2)).toBe(new Decimal(o.totals["budget"] ?? 0).toFixed(2)); // any axes: same leaves, same total
    expect(Number(o.period.elapsed)).toBeGreaterThan(0);
    const platforms = (await as("planner", "GET", `/api/v1/workspaces/${golden.workspaceId}/overview`)).body as Body & { heatmap: { cols: string[]; cells: Array<{ col: string | null }> } };
    expect([...platforms.heatmap.cols].sort()).toEqual([...new Set(platforms.heatmap.cells.map((c) => c.col).filter((c): c is string => c !== null))].sort()); // every platform, none cut off
    expect((await as("planner", "GET", `/api/v1/workspaces/${golden.workspaceId}/overview?rows=region&cols=region`)).status).toBe(422);
    expect((await as("planner", "GET", `/api/v1/workspaces/${golden.workspaceId}/overview?rows=nope`)).status).toBe(422);
  });

  it("needs attention ranks live budgets by money at stake, in four kinds, ended ones left out (HO-010, ADR-064); fast", async () => {
    const started = Date.now();
    const res = await as("budgetOwner", "GET", `/api/v1/workspaces/${golden.workspaceId}/overview?period=current_year`);
    const elapsed = Date.now() - started;
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    type Item = { category: string; envelopeId: string; money: string; pace_index: string | null; actual: string | null; ahead_of_plan_abs: string | null };
    const o = res.body as Body & {
      attention: { all: Item[]; over: Item[]; under: Item[]; noSpend: Item[]; kpi: Item[]; counts: Record<string, number> };
      queue: { waiting: number; overdue: number; byRole: Array<{ role: string; count: number }> };
      freshness: { lastFactDate: string | null; sources: Array<{ name: string }>; projections: unknown };
      kpi: { rows: Array<{ code: string; target: string | null; vsTargetPct: string | null }> } | null;
      headline: { projected: string | null };
      elapsedMs: number;
    };
    const a = o.attention;
    const num = (v: string | null) => Number(v ?? 0);
    // Over pace: past the on-plan band and ahead, the largest amount first.
    expect(a.over.length).toBeGreaterThan(0);
    expect(a.over.every((i) => num(i.pace_index) >= 1.05 && num(i.ahead_of_plan_abs) > 0)).toBe(true);
    expect(a.over.map((i) => num(i.ahead_of_plan_abs))).toEqual([...a.over.map((i) => num(i.ahead_of_plan_abs))].sort((x, y) => y - x));
    // Under pace (with some spend) and no spend yet: behind, the largest gap first.
    expect(a.under.every((i) => num(i.actual) > 0 && num(i.pace_index) < 0.95 && num(i.ahead_of_plan_abs) < 0)).toBe(true);
    expect(a.noSpend.length).toBeGreaterThan(0); // the golden's Walmart and Mercado Libre splits have spent nothing
    expect(a.noSpend.every((i) => num(i.actual) === 0 && num(i.ahead_of_plan_abs) < 0)).toBe(true);
    // KPI off target: CPA more than 10% over, money = what it costs above target.
    expect(a.kpi.length).toBeGreaterThan(0);
    expect(a.kpi.every((i) => num(i.money) > 0)).toBe(true);
    // All: one row per budget, by the size of the money at stake.
    const sizes = a.all.map((i) => Math.abs(num(i.money)));
    expect([...sizes].sort((x, y) => y - x)).toEqual(sizes);
    expect(new Set(a.all.map((i) => i.envelopeId)).size).toBe(a.all.length);
    for (const k of ["over", "under", "noSpend", "kpi"] as const) expect(a.counts[k], k).toBeGreaterThanOrEqual(a[k].length);
    // The ended ES tiktok leaf (GOLDEN_HISTORY) needs no attention.
    const ended = await owner.envelope.findMany({ where: { workspaceId: golden.workspaceId, endedAt: { not: null } }, select: { id: true } });
    expect(ended.length).toBeGreaterThan(0);
    for (const e of ended) expect([...a.all, ...a.over, ...a.under, ...a.noSpend, ...a.kpi].map((i) => i.envelopeId)).not.toContain(e.id);
    // The workspace's queue, not the caller's list; freshness; CPA by market, worst gap first.
    expect(o.queue.waiting).toBeGreaterThan(0); // the golden bulk waits
    expect(o.queue.byRole.map((r) => r.role)).toContain("BUDGET_OWNER");
    expect(o.freshness.lastFactDate).toBe("2026-08-01");
    expect(o.freshness.sources.map((s) => s.name)).toContain("Golden actuals (CSV)");
    expect(o.freshness.projections).toBeNull(); // the golden has no projections
    expect(o.headline.projected).toBeNull(); // not computed, not 0
    const gaps = (o.kpi?.rows ?? []).map((r) => r.vsTargetPct).filter((g): g is string => g !== null).map(Number);
    expect(gaps.length).toBeGreaterThan(0);
    expect([...gaps].sort((x, y) => y - x)).toEqual(gaps);
    expect(o.elapsedMs).toBeLessThan(perfBudgetMs(1500));
    expect(elapsed).toBeLessThan(perfBudgetMs(1500));
  });

  it("the heatmap has its margins from the planner, each cell's open alerts, and a server-side sort (HO-010)", async () => {
    type M = { code: string | null; budget: string | null; alerts: number; pace_index: string | null };
    const res = await as("planner", "GET", `/api/v1/workspaces/${golden.workspaceId}/overview`);
    const o = res.body as Body & { heatmap: { rows: string[]; cols: string[]; cells: Array<{ alerts: number; pending: number }>; rowTotals: M[]; colTotals: M[]; total: Record<string, string | null> }; totals: Record<string, string>; alerts: { open: number; byRule: Array<{ ruleName: string; count: number; budgets: number; covered: number | null; byRow: Array<{ count: number }> }>; byRow: Array<{ count: number }> } };
    const byCountry = await as("planner", "POST", `/api/v1/workspaces/${golden.workspaceId}/query`, { workspaceId: golden.workspaceId, period: { kind: "relative", preset: "current_year" }, filter: { logic: "and", children: LIVE_LEAVES }, groupBy: ["country"], measures: ["budget"], limit: 100 });
    const planner = Object.fromEntries((byCountry.body["rows"] as Array<{ dimensions: Record<string, string>; measures: Record<string, string> }>).map((r) => [r.dimensions["country"], r.measures["budget"]]));
    for (const m of o.heatmap.rowTotals) expect(m.budget, String(m.code)).toBe(planner[m.code ?? ""]);
    expect(o.heatmap.total["budget"]).toBe(o.totals["budget"]);
    // Every open alert sits on one cell and in one row and one column (the golden's leaves have both).
    const sum = (xs: Array<{ alerts: number }>) => xs.reduce((n, x) => n + x.alerts, 0);
    expect(sum(o.heatmap.cells)).toBe(o.alerts.open);
    expect(sum(o.heatmap.rowTotals)).toBe(o.alerts.open);
    expect(sum(o.heatmap.colTotals)).toBe(o.alerts.open);
    expect(o.heatmap.cells.reduce((n, c) => n + c.pending, 0)).toBeGreaterThanOrEqual(24); // the golden bulk's budgets wait
    // Alerts by rule: they add up; a rule that fires on many budgets says how many it covers.
    expect(o.alerts.byRule.reduce((n, r) => n + r.count, 0)).toBe(o.alerts.open);
    expect(o.alerts.byRow.reduce((n, r) => n + r.count, 0)).toBe(o.alerts.open);
    const cpa = o.alerts.byRule.find((r) => r.ruleName === "CPA over target");
    expect(cpa?.covered).not.toBeNull();
    expect(cpa?.covered ?? 0).toBeGreaterThanOrEqual(cpa?.budgets ?? 0);
    // Sort: rows by pace, fastest first, as the planner orders them.
    const paced = (await as("planner", "GET", `/api/v1/workspaces/${golden.workspaceId}/overview?sort=pace`)).body as typeof o;
    const paces = paced.heatmap.rows.map((code) => Number(paced.heatmap.rowTotals.find((m) => m.code === code)?.pace_index ?? 0));
    expect([...paces].sort((x, y) => y - x)).toEqual(paces);
    expect((await as("planner", "GET", `/api/v1/workspaces/${golden.workspaceId}/overview?sort=nope`)).status).toBe(422);
  });

  it("the headline: what is left and the rate that spends it; the change since the plan snapshot, or since one asked for (HO-010)", async () => {
    const res = await as("planner", "GET", `/api/v1/workspaces/${golden.workspaceId}/overview`);
    const o = res.body as Body & { headline: Record<string, string | null>; period: { end: string; daysLeft: number }; compare: { id: string; name: string; explicit: boolean; changeAbs: string } | null };
    expect(o.headline["remaining"]).toBe(new Decimal(o.headline["budget"] ?? 0).minus(o.headline["actual"] ?? 0).toFixed(2));
    expect(o.headline["unassigned"]).toBe(new Decimal(o.headline["budget"] ?? 0).minus(o.headline["assigned"] ?? 0).toFixed(2));
    expect(o.headline["assignedPct"]).toBe(new Decimal(o.headline["assigned"] ?? 0).div(o.headline["budget"] ?? 1).toDecimalPlaces(4).toString());
    const today = new Date().toISOString().slice(0, 10);
    expect(o.period.daysLeft).toBe(Math.max(0, Math.round((Date.parse(`${o.period.end}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)));
    expect(o.headline["runRateNeeded"]).toBe(o.period.daysLeft === 0 ? null : new Decimal(o.headline["remaining"] ?? 0).div(o.period.daysLeft).toDecimalPlaces(2).toFixed(2));
    // The golden's FY2026 plan snapshot is the default comparison.
    expect(o.compare).toMatchObject({ name: "FY2026 plan", explicit: false });
    const asked = await as("planner", "GET", `/api/v1/workspaces/${golden.workspaceId}/overview?compareTo=${o.compare?.id ?? ""}`);
    expect(asked.status, JSON.stringify(asked.body).slice(0, 300)).toBe(200);
    const withBaseline = asked.body as Body & { compare: { explicit: boolean }; heatmap: { cells: Array<{ budget_baseline?: string | null }> } };
    expect(withBaseline.compare.explicit).toBe(true);
    expect(withBaseline.heatmap.cells.some((c) => c.budget_baseline !== undefined && c.budget_baseline !== null)).toBe(true);
    expect((await as("planner", "GET", `/api/v1/workspaces/${golden.workspaceId}/overview?compareTo=${"0".repeat(8)}-0000-7000-8000-000000000000`)).status).toBe(404);
  });

  it("counts open alerts the way Home does: open or acknowledged, as the caller may read them (HO-001)", async () => {
    const ws = golden.workspaceId;
    const [first] = await owner.alert.findMany({ where: { workspaceId: ws, status: "OPEN" }, orderBy: { openedAt: "asc" }, take: 1, select: { id: true } });
    expect(first, "the golden has open alerts").toBeDefined();
    // An acknowledged alert is still open: someone saw it, nobody resolved it.
    const ack = await as("budgetOwner", "PATCH", `/api/v1/alerts/${first?.id ?? ""}`, { status: "ACKNOWLEDGED" });
    expect(ack.status, JSON.stringify(ack.body)).toBe(200);
    const inDb = await owner.alert.count({ where: { workspaceId: ws, status: { in: ["OPEN", "ACKNOWLEDGED"] } } });
    for (const persona of ["orgAdmin", "planner", "finance1", "approver"]) {
      const o = (await as(persona, "GET", `/api/v1/workspaces/${ws}/overview`)).body as { alerts: { open: number; counts: Record<string, number> } };
      const home = (await as(persona, "GET", "/api/v1/me/home")).body as { totals: { openAlerts: number } };
      expect(home.totals.openAlerts, persona).toBe(o.alerts.open);
      expect(o.alerts.open, persona).toBe(inDb); // the golden personas read the whole workspace
      expect(Object.values(o.alerts.counts).reduce((s, n) => s + n, 0), persona).toBe(o.alerts.open);
    }
  });

  it("counts time gone through the last day the actuals cover: the golden's monthly August rows run to 31 August (HO-003, ADR-062)", async () => {
    const res = await as("planner", "GET", `/api/v1/workspaces/${golden.workspaceId}/overview?period=current_year`);
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    const o = res.body as { asOf: Record<string, unknown>; period: { start: string; end: string; elapsed: string; elapsedToday: string }; totals: Record<string, string> };
    const today = new Date().toISOString().slice(0, 10);
    const through = "2026-08-31" < today ? "2026-08-31" : today;
    expect(o.asOf).toMatchObject({ lastFactDate: "2026-08-01", through, grain: "month" });
    const gone = elapsedFraction(o.period, through);
    expect(o.period.elapsed).toBe(gone.toDecimalPlaces(4).toString());
    expect(o.period.elapsedToday).toBe(elapsedFraction(o.period, today).toDecimalPlaces(4).toString());
    // The heatmap's total pace divides by that share, not by the share gone today.
    const pace = new Decimal(o.totals["actual"] ?? 0).div(o.totals["budget_in_period"] ?? 1).div(gone);
    expect(new Decimal(o.totals["pace_index"] ?? 0).toDecimalPlaces(4).toString()).toBe(pace.toDecimalPlaces(4).toString());
    // Home reads the same day, and its strips' pace with it.
    const home = (await as("planner", "GET", "/api/v1/me/home")).body as { asOf: Record<string, unknown> & { elapsed: string } };
    expect(home.asOf).toMatchObject({ lastFactDate: "2026-08-01", through, grain: "month", elapsed: gone.toDecimalPlaces(4).toString() });
  });

  it("GET /pacing reads the same pace as the Overview for the same budgets, by default (T-9, ADR-062 addendum)", async () => {
    const overviewRes = await as("planner", "GET", `/api/v1/workspaces/${golden.workspaceId}/overview?period=current_year`);
    expect(overviewRes.status, JSON.stringify(overviewRes.body).slice(0, 300)).toBe(200);
    const overview = overviewRes.body as { totals: Record<string, string> };
    // Same population as the heatmap (ADR-016 live leaves), same period: GET /pacing no longer counts
    // time gone to today while the Overview counts it to the last day the actuals cover.
    const filter = encodeURIComponent(JSON.stringify({ logic: "and", children: LIVE_LEAVES }));
    const pacingRes = await as("planner", "GET", `/api/v1/workspaces/${golden.workspaceId}/pacing?filter=${filter}&period=current_year&limit=1`);
    expect(pacingRes.status, JSON.stringify(pacingRes.body).slice(0, 300)).toBe(200);
    const pacing = pacingRes.body as { totals: Record<string, string> };
    expect(new Decimal(pacing.totals["pace_index"] ?? 0).toDecimalPlaces(4).toString()).toBe(new Decimal(overview.totals["pace_index"] ?? 0).toDecimalPlaces(4).toString());
  });

  it("rejects an unknown period, and needs envelope.read", async () => {
    expect((await as("planner", "GET", `/api/v1/workspaces/${golden.workspaceId}/overview?period=forever`)).status).toBe(422);
    expect((await as("planner", "GET", `/api/v1/workspaces/${golden.workspaceId}/overview?period=fiscal:nope`)).status).toBe(422);
  });

  it("takes one of the workspace's own periods as fiscal:<key>, like the Explorer (feedback)", async () => {
    const res = await as("planner", "GET", `/api/v1/workspaces/${golden.workspaceId}/overview?period=fiscal:2026-Q2`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body as { period: { start: string; end: string } }).period).toMatchObject({ start: "2026-04-01", end: "2026-06-30" });
  });

  // Last: it loads projections, which the tests above expect none of.
  it("projects the close only from loaded projections, and says which source loaded them (HO-012)", async () => {
    const ws = golden.workspaceId;
    const runId = golden.ingest?.runId;
    if (!runId) throw new Error("the golden has no ingest run");
    const [leaf] = await owner.$queryRaw<Array<{ id: string }>>`
      SELECT e.id FROM envelope e WHERE e.workspace_id = ${ws}::uuid AND e.status = 'APPROVED' AND e.ended_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM envelope c WHERE c.parent_id = e.id) ORDER BY e.id LIMIT 1`;
    if (!leaf) throw new Error("no live leaf");
    try {
      await owner.$executeRaw`
        INSERT INTO projection_fact (workspace_id, envelope_id, dimension_values, period_date, metric, value, value_reporting, formula_version, horizon_end, source_system, source_run_id)
        VALUES (${ws}::uuid, ${leaf.id}::uuid, '{}'::jsonb, '2026-06-15', 'spend', 1234.5, 1234.5, 'ho-012-test', '2026-12-31', 'test', ${runId}::uuid)`;
      const o = (await as("planner", "GET", `/api/v1/workspaces/${ws}/overview`)).body as { headline: { projected: string | null; projectedClosePct: string | null }; freshness: { projections: { source: string | null; loadedAt: string } | null } };
      expect(o.headline.projected).not.toBeNull();
      expect(new Decimal(o.headline.projected ?? 0).gte("1234.50")).toBe(true);
      expect(o.headline.projectedClosePct).not.toBeNull();
      expect(o.freshness.projections).toMatchObject({ source: "Golden actuals (CSV)" });
    } finally {
      await owner.$executeRaw`DELETE FROM projection_fact WHERE workspace_id = ${ws}::uuid AND formula_version = 'ho-012-test'`;
    }
  });
});

describe("GET /workspaces/:ws/overview — no heatmap axes (T-3)", () => {
  // A workspace with live leaves but no country|market|region or platform|channel dimension: `heat`
  // is null. `assigned`/`totals` must still cover every live leaf, not only the "over pace" subset.
  const orgId = randomUUID();
  const ws = randomUUID();
  const owner_ = testUser("t3-noaxes", randomUUID());

  async function leaf(name: string, budget: string, spend: string): Promise<string> {
    const id = randomUUID();
    const v = randomUUID();
    await owner.$executeRawUnsafe(
      `INSERT INTO envelope (id, workspace_id, name, dimension_values, start_date, end_date, currency, status, created_by, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, '{}'::jsonb, '2026-01-01', '2026-12-31', 'USD', 'APPROVED', $4::uuid, now())`,
      id,
      ws,
      name,
      owner_.id,
    );
    await owner.$executeRawUnsafe(
      `INSERT INTO envelope_version (id, envelope_id, version_no, amount, amount_reporting, status, created_by, approved_at) VALUES ($1::uuid, $2::uuid, 1, $3::numeric, $3::numeric, 'APPROVED', $4::uuid, '2026-01-02T00:00:00Z')`,
      v,
      id,
      budget,
      owner_.id,
    );
    await owner.$executeRawUnsafe(`UPDATE envelope SET current_version_id = $2::uuid WHERE id = $1::uuid`, id, v);
    await owner.$executeRawUnsafe(
      `INSERT INTO spend_fact (workspace_id, envelope_id, dimension_values, period_date, currency, amount, amount_reporting, source_system, source_run_id, source_row_hash) VALUES ($1::uuid, $2::uuid, '{}'::jsonb, '2026-09-15', 'USD', $3::numeric, $3::numeric, 'fixture', $4::uuid, $5)`,
      ws,
      id,
      spend,
      randomUUID(),
      randomUUID(),
    );
    return id;
  }

  beforeAll(async () => {
    await owner.organization.create({ data: { id: orgId, name: "t3-no-axes" } });
    await owner.workspace.create({ data: { id: ws, orgId, slug: `t3-${ws}`, name: "T-3 no axes", reportingCurrency: "USD" } });
    await owner.user.create({ data: { id: owner_.id, orgId, email: owner_.email, name: owner_.email, googleSub: `g-${owner_.sub}` } });
    await owner.roleAssignment.create({ data: { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: owner_.id, role: "BUDGET_OWNER", createdBy: owner_.id } });
    // Two top-level leaves, no dimensions at all: one well over pace, one well under. Over-pace alone
    // (1500.00) must not stand in for the workspace's live-leaf total (1500.00 + 800.00 = 2300.00).
    await leaf("Over", "1500.00", "1400.00");
    await leaf("Under", "800.00", "300.00");
  }, 60_000);

  afterAll(async () => {
    await owner.$executeRawUnsafe(`DELETE FROM spend_fact WHERE workspace_id = $1::uuid`, ws);
    await owner.$executeRawUnsafe(`UPDATE envelope SET current_version_id = NULL WHERE workspace_id = $1::uuid`, ws);
    await owner.$executeRawUnsafe(`DELETE FROM envelope_version WHERE envelope_id IN (SELECT id FROM envelope WHERE workspace_id = $1::uuid)`, ws);
    await owner.$executeRawUnsafe(`DELETE FROM envelope WHERE workspace_id = $1::uuid`, ws);
    await owner.$executeRawUnsafe(`DELETE FROM outbox WHERE workspace_id = $1::uuid`, ws);
    await owner.roleAssignment.deleteMany({ where: { workspaceId: ws } });
    await owner.user.deleteMany({ where: { id: owner_.id } });
    await owner.workspace.deleteMany({ where: { id: ws } });
    await owner.organization.deleteMany({ where: { id: orgId } });
  });

  it("assigned/totals cover every live leaf, not only the over-pace subset, when the workspace has no row/col axes", async () => {
    const token = await h.mint(owner_);
    const res = await h.call("GET", `/api/v1/workspaces/${ws}/overview`, token, { headers: { "x-workspace-id": ws } });
    expect(res.status, JSON.stringify(res.body).slice(0, 500)).toBe(200);
    const o = res.body as { heatmap: unknown; totals: Record<string, string>; headline: Record<string, string | null> | null };
    expect(o.heatmap).toBeNull(); // no country/platform-family axes: no heatmap
    const allLeaves = new Decimal("1500.00").plus("800.00");
    expect(new Decimal(o.totals["budget"] ?? 0).toFixed(2)).toBe(allLeaves.toFixed(2));
    expect(o.headline).not.toBeNull();
    expect(new Decimal(o.headline?.["assigned"] ?? 0).toFixed(2)).toBe(allLeaves.toFixed(2));
    expect(o.headline?.["unassigned"]).toBe("0.00"); // both leaves are also the top-level budgets
    expect(o.headline?.["assignedPct"]).toBe(new Decimal(o.headline?.["assigned"] ?? 0).div(o.headline?.["budget"] ?? 1).toDecimalPlaces(4).toString());
  });
});
