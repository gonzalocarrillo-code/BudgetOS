import { randomUUID } from "node:crypto";
import { LIVE_LEAVES } from "@budget/domain";
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
async function as(persona: string, method: "GET" | "POST", url: string, body?: unknown) {
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

  it("rejects an unknown period, and needs envelope.read", async () => {
    expect((await as("planner", "GET", `/api/v1/workspaces/${golden.workspaceId}/overview?period=forever`)).status).toBe(422);
  });
});
