import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/api.js", () => ({
  unwrap: async (p: Promise<unknown>) => p,
  api: {
    POST: vi.fn(async (path: string) =>
      path.endsWith("/tree")
        ? { available: true, reason: null, rows: [{ key: "∅", envelopeId: null, nodeEnvelopeId: null, path: ["∅"], dimensions: { client: null }, measures: { budget: "10.00" }, targets: {}, status: null, pendingCount: 0, openAlerts: 0, openThreads: 0 }], totals: { budget: "10.00" }, dataAsOf: "2026-09-28T00:00:00.000Z", dataVersion: 1, cacheVersion: 1, elapsedMs: 1 }
        : { rows: [{ key: "∅/∅", envelopeId: null, path: ["∅", "∅"], dimensions: { client: null, region: null }, measures: {}, targets: {}, status: null, pendingCount: 0, openAlerts: 0, openThreads: 0 }], nextCursor: null, totals: {}, dataAsOf: "2026-09-28T00:00:00.000Z", dataVersion: 1, elapsedMs: 1 },
    ),
  },
}));

const { explorerLabels } = await import("./labels.js");
const { ExplorerRowSource } = await import("./row-source.js");

const dims = [
  { key: "client", label: "Client", values: [] },
  { key: "region", label: "Region", values: [{ code: "LATAM", label: "Latin America" }] },
];

describe("Explorer labels (product feedback 2: the root is the account, not '(none)')", () => {
  it("a first-level group with no value is the account; deeper, 'No <granularity>'", () => {
    const l = explorerLabels(dims, "Golden");
    expect(l.none("client", 0)).toBe("Golden");
    expect(l.none("region", 1)).toBe("No Region");
    expect(l.value("region", "LATAM")).toBe("Latin America");
    expect(explorerLabels(dims, null).none("client", 0)).toBe("No Client");
  });

  it("a pivot's empty group says what is missing", async () => {
    const labels = explorerLabels(dims, "Golden");
    const pivot = new ExplorerRowSource({ ws: "w", view: "pivot", filter: { logic: "and", children: [] }, period: {}, measures: ["budget"], levels: [], groupBy: ["client", "region"], expanded: [], sort: [] }, labels, () => undefined);
    expect((await pivot.getRows({ start: 0, end: 10 })).rows.map((r) => (r as { name: string }).name)).toEqual(["No Client · No Region"]);
  });
});
