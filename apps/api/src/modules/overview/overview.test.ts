import { randomUUID } from "node:crypto";
import { LIVE_LEAVES, TOP_LEVEL } from "@budget/domain";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGolden, type GoldenResult } from "../../seed/golden.js";
import { appDb as appDbClient, ownerDb, startHarness, type Harness } from "../../test-support/harness.js";
import { cleanupGolden } from "../../test-support/golden-cleanup.js";

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

  it("top variances are over and under, largest first; alerts, approvals and freshness are there; fast", async () => {
    const started = Date.now();
    const res = await as("budgetOwner", "GET", `/api/v1/workspaces/${golden.workspaceId}/overview?period=current_year`);
    const elapsed = Date.now() - started;
    const o = res.body as Body & {
      variances: { over: Array<{ pace_index: string }>; under: Array<{ pace_index: string }> };
      alerts: { open: number; counts: Record<string, number>; latest: unknown[] };
      approvals: { mine: number; due: Array<{ dueAt: string | null }> };
      freshness: { lastFactDate: string | null; sources: Array<{ name: string; lastRun: { status: string } | null }> };
      kpi: { rows: Array<{ code: string; target: string | null }> } | null;
      elapsedMs: number;
    };
    // Over / under pace: spend so far against the phased plan (golden has no projections).
    const over = o.variances.over.map((v) => Number(v.pace_index));
    expect(over.length).toBeGreaterThan(0);
    expect(over.every((v) => v > 1)).toBe(true);
    expect([...over].sort((a, b) => b - a)).toEqual(over);
    expect(o.variances.under.every((v) => Number(v.pace_index) < 1)).toBe(true);
    expect(Object.values(o.alerts.counts).reduce((s, n) => s + n, 0)).toBe(o.alerts.open);
    expect(o.alerts.latest.length).toBe(Math.min(5, o.alerts.open));
    expect(o.approvals.mine).toBeGreaterThan(0); // the golden bulk waits on the budget owner
    expect(o.freshness.lastFactDate).toBe("2026-08-01");
    expect(o.freshness.sources.map((s) => s.name)).toContain("Golden actuals (CSV)");
    const withTarget = o.kpi?.rows.filter((r) => r.target !== null) ?? [];
    expect(withTarget.length).toBeGreaterThan(0); // the golden CPA targets on every country budget
    expect(o.elapsedMs).toBeLessThan(1500);
    expect((o as unknown as { totals: Record<string, string | null> }).totals["projected"]).toBeNull(); // the golden has no projections: not computed, not 0
    expect(elapsed).toBeLessThan(1500);
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

  it("rejects an unknown period, and needs envelope.read", async () => {
    expect((await as("planner", "GET", `/api/v1/workspaces/${golden.workspaceId}/overview?period=forever`)).status).toBe(422);
    expect((await as("planner", "GET", `/api/v1/workspaces/${golden.workspaceId}/overview?period=fiscal:nope`)).status).toBe(422);
  });

  it("takes one of the workspace's own periods as fiscal:<key>, like the Explorer (feedback)", async () => {
    const res = await as("planner", "GET", `/api/v1/workspaces/${golden.workspaceId}/overview?period=fiscal:2026-Q2`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body as { period: { start: string; end: string } }).period).toMatchObject({ start: "2026-04-01", end: "2026-06-30" });
  });
});
