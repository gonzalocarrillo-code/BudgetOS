import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedGolden, type GoldenResult } from "../../seed/golden.js";
import { cleanupGolden } from "../../test-support/golden-cleanup.js";
import { appDb, ownerDb, startHarness, type Harness } from "../../test-support/harness.js";

/**
 * Product feedback 2026-09-28 (ADR-050): Budgets follows the budget structure the planner built —
 * parent links, not granularities. Each row is one budget with its own amount; its spend and
 * projection are its own plus everything under it.
 */

const owner = ownerDb();
const app = appDb();
let h: Harness;
let golden: GoldenResult;
const slug = `struct-${randomUUID().slice(0, 8)}`;
type Row = { envelopeId: string; parentId?: string | null; childCount?: number; measures: Record<string, string | null> };

async function query(body: Record<string, unknown>) {
  const token = await h.mint({ sub: "ip-planner", email: `planner@${slug}.golden.test` }, { googleSub: `golden-${slug}-planner` });
  const res = await h.call("POST", `/api/v1/workspaces/${golden.workspaceId}/query`, token, { headers: { "x-workspace-id": golden.workspaceId }, body: { workspaceId: golden.workspaceId, period: { kind: "relative", preset: "current_year" }, measures: ["budget", "actual", "projected"], limit: 1000, ...body } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as { rows: Row[] }).rows;
}
const live = { field: { kind: "attr", key: "status" }, op: "neq", value: "ARCHIVED" };
const under = (id: string | null) => (id === null ? { field: { kind: "attr", key: "parent_id" }, op: "is_empty" } : { field: { kind: "attr", key: "parent_id" }, op: "eq", value: id });

beforeAll(async () => {
  golden = await seedGolden(app, owner, { slug });
  h = await startHarness();
}, 180_000);
afterAll(async () => {
  await h?.close();
  if (golden?.created) await cleanupGolden(owner, golden);
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("budget structure (subtree)", () => {
  it("top-level budgets, then each one's children; a parent's spend is its own plus its children's", async () => {
    const roots = await query({ subtree: true, filter: { logic: "and", children: [live, under(null)] } });
    expect(roots.length).toBeGreaterThan(0);
    expect(roots.every((r) => r.parentId === null)).toBe(true);
    const parent = roots.find((r) => (r.childCount ?? 0) > 0);
    expect(parent, "a top-level budget with children").toBeDefined();

    const kids = await query({ subtree: true, filter: { logic: "and", children: [live, under(parent!.envelopeId)] } });
    expect(kids).toHaveLength(parent!.childCount!);
    expect(kids.every((k) => k.parentId === parent!.envelopeId)).toBe(true);

    // Its own row without the subtree: the same budget, only its own spend.
    const flat = (await query({ filter: { logic: "and", children: [live, under(null)] } })).find((r) => r.envelopeId === parent!.envelopeId);
    expect(parent!.measures["budget"]).toBe(flat?.measures["budget"]);
    const sum = (k: string) => kids.reduce((a, r) => a.plus(r.measures[k] ?? 0), new Decimal(flat?.measures[k] ?? 0));
    expect(new Decimal(parent!.measures["actual"] ?? 0).toFixed(2)).toBe(sum("actual").toFixed(2));
    expect(new Decimal(parent!.measures["projected"] ?? 0).toFixed(2)).toBe(sum("projected").toFixed(2));
    expect(sum("actual").gt(0), "golden spend sits on the leaves").toBe(true);
  });

  it("the timeline nests the same way: parents first, each budget one level under its parent", async () => {
    const token = await h.mint({ sub: "ip-planner", email: `planner@${slug}.golden.test` }, { googleSub: `golden-${slug}-planner` });
    const res = await h.call("GET", `/api/v1/workspaces/${golden.workspaceId}/timeline?structure=true&period=current_year`, token, { headers: { "x-workspace-id": golden.workspaceId } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const bars = (res.body as { bars: Array<{ key: string; kind: string; parentKey: string | null; level: number; hasChildren: boolean }> }).bars.filter((b) => b.kind === "envelope");
    const seen = new Map<string, number>();
    for (const b of bars) {
      if (b.parentKey === null) expect(b.level).toBe(0);
      else expect(b.level, "a child comes after its parent, one level deeper").toBe((seen.get(b.parentKey) ?? -99) + 1);
      seen.set(b.key, b.level);
    }
    expect(bars.some((b) => b.level > 0)).toBe(true);
    expect(bars.some((b) => b.level === 0 && b.hasChildren)).toBe(true);
  });
});
