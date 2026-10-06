import { describe, expect, it, vi } from "vitest";

/**
 * Product feedback 2026-09-28 (ADR-049): a group with no value for its level is not a row. What it
 * holds sits one level up, first — so a budget with no granularities is at the top of the tree,
 * and a workspace that sets no client shows no Client level.
 */

const row = (path: string[], keys: string[], budget: string) => ({
  key: path.join("/"),
  envelopeId: null,
  nodeEnvelopeId: null,
  path,
  dimensions: Object.fromEntries(keys.map((k, i) => [k, path[i] === "∅" ? null : (path[i] ?? null)])),
  measures: { budget },
  targets: {},
  status: null,
  pendingCount: 0,
  openAlerts: 0,
  openThreads: 0,
});
const envelope = (id: string, name: string) => ({ ...row([name], [], "150000000.00"), key: id, envelopeId: id, path: [name] });

// client > region: one budget with no granularities, one EMEA budget without a client, one Acme > LATAM.
const TREE: Record<string, unknown[]> = {
  "": [row(["∅"], ["client"], "200.00"), row(["acme"], ["client"], "50.00")],
  "∅": [row(["∅", "∅"], ["client", "region"], "150.00"), row(["∅", "EMEA"], ["client", "region"], "50.00")],
  acme: [row(["acme", "LATAM"], ["client", "region"], "50.00")],
};

vi.mock("../../lib/api.js", () => ({
  unwrap: async (p: Promise<unknown>) => p,
  api: {
    POST: vi.fn(async (path: string, init: { body: { parentPath?: string } }) =>
      path.endsWith("/tree")
        ? { available: true, reason: null, rows: TREE[init.body.parentPath ?? ""] ?? [], totals: { budget: "250.00" }, dataAsOf: "2026-09-28T00:00:00.000Z", dataVersion: 1, cacheVersion: 1, elapsedMs: 1 }
        : { rows: [envelope("00000000-0000-4000-8000-0000000000f1", "FY2026 Media")], nextCursor: null, totals: {}, dataAsOf: "2026-09-28T00:00:00.000Z", dataVersion: 1, elapsedMs: 1 },
    ),
  },
}));

const { ExplorerRowSource } = await import("./row-source.js");
const { api } = await import("../../lib/api.js");
const labels = { value: (_d: string, code: string) => code, none: (d: string) => `No ${d}`, notSplit: (name: string) => `${name} · not split` };

describe("the Budgets tree folds no-value groups into the level above", () => {
  it("a budget with no granularities is at the top; a client-less region sits beside the clients", async () => {
    const tree = new ExplorerRowSource({ ws: "w", view: "tree", filter: { logic: "and", children: [] }, period: {}, measures: ["budget"], templateId: "00000000-0000-4000-8000-000000000001", levels: ["client", "region"], groupBy: [], expanded: [], sort: [] }, labels, () => undefined);
    const rows = (await tree.getRows({ start: 0, end: 10 })).rows as Array<{ name: string; level: number; hasChildren: boolean; key: string }>;
    expect(rows.map((r) => [r.name, r.level, r.hasChildren])).toEqual([
      ["FY2026 Media", 0, false],
      ["EMEA", 0, true],
      ["acme", 0, true],
    ]);
    expect(rows.some((r) => r.name.startsWith("No "))).toBe(false);
    // Expanding a folded group's child keeps its real path.
    await tree.toggle("acme");
    const after = (await tree.getRows({ start: 0, end: 10 })).rows as Array<{ name: string; level: number }>;
    expect(after.map((r) => [r.name, r.level])).toEqual([["FY2026 Media", 0], ["EMEA", 0], ["acme", 0], ["LATAM", 1]]);
  });
});

describe("HF-1 (audit T-5 follow-up): includeDemo follows the 'Show demo data' param", () => {
  const post = api.POST as unknown as { mock: { calls: Array<[string, { body: { includeDemo?: boolean } }]> } };

  it("/query carries includeDemo: true only when the source asks for it", async () => {
    post.mock.calls.length = 0;
    const shown = new ExplorerRowSource({ ws: "w", view: "pivot", filter: { logic: "and", children: [] }, period: {}, measures: ["budget"], levels: [], groupBy: [], expanded: [], sort: [], includeDemo: true }, labels, () => undefined);
    await shown.getRows({ start: 0, end: 10 });
    const queryCalls = post.mock.calls.filter(([path]) => path.endsWith("/query"));
    expect(queryCalls.length).toBeGreaterThan(0);
    expect(queryCalls.every(([, init]) => init.body.includeDemo === true)).toBe(true);

    post.mock.calls.length = 0;
    const hidden = new ExplorerRowSource({ ws: "w", view: "pivot", filter: { logic: "and", children: [] }, period: {}, measures: ["budget"], levels: [], groupBy: [], expanded: [], sort: [] }, labels, () => undefined);
    await hidden.getRows({ start: 0, end: 10 });
    const defaultCalls = post.mock.calls.filter(([path]) => path.endsWith("/query"));
    expect(defaultCalls.length).toBeGreaterThan(0);
    expect(defaultCalls.every(([, init]) => init.body.includeDemo === false)).toBe(true);
  });
});

describe("the structure tree with a filter (owner feedback, 2026-09-30)", () => {
  it("lists the matching lowest-level budgets by their path, not top-level budgets that carry no such value", async () => {
    const { api } = await import("../../lib/api.js");
    const post = api.POST as unknown as ReturnType<typeof vi.fn>;
    post.mockClear();
    post.mockImplementationOnce(async () => ({ rows: [{ ...envelope("00000000-0000-4000-8000-0000000000f2", "MX google_ads conversion"), path: ["FY2026 Media", "LATAM", "MX google_ads conversion"] }], nextCursor: null, totals: { budget: "42000.00" }, dataAsOf: "2026-09-30T00:00:00.000Z", dataVersion: 1, elapsedMs: 1 }));
    const filter = { logic: "and" as const, children: [{ field: { kind: "dimension" as const, key: "country" }, op: "eq" as const, value: "MX" }] };
    const tree = new ExplorerRowSource({ ws: "w", view: "tree", structure: true, filter, period: {}, measures: ["budget"], levels: [], groupBy: [], expanded: [], sort: [] }, labels, () => undefined);
    const rows = (await tree.getRows({ start: 0, end: 10 })).rows as Array<{ name: string; hasChildren: boolean }>;
    expect(rows).toEqual([expect.objectContaining({ name: "FY2026 Media › LATAM › MX google_ads conversion", hasChildren: false })]);
    const body = (post.mock.calls[0]?.[1] as { body: { filter: { children: Array<{ field: { key: string } }> } } }).body;
    const keys = body.filter.children.map((c) => ("field" in c ? c.field.key : "group"));
    expect(keys).toContain("is_leaf");
    expect(keys).not.toContain("parent_id");
  });
});
