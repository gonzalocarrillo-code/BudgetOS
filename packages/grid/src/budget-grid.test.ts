import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  buildCell,
  createRowCache,
  editorAction,
  forwardPaste,
  parseDate,
  parseMoney,
  parsePercent,
  type ColumnSpec,
  type QueryRow,
  type RowSource,
} from "./index.js";

const gridRoot = dirname(fileURLToPath(import.meta.url));

const CELL_KINDS = ["path", "money", "pace", "target", "status", "chips", "dimension"] as const;

function row(index: number, extra?: { hasChildren?: boolean; expanded?: boolean }): QueryRow {
  const base = {
    key: `row-${index}`,
    envelopeId: null,
    depth: 1,
    path: ["LATAM", `Brazil-${index}`],
    dimensions: { country: "BR" },
    measures: {
      budget: "1200000.00",
      actual: "800000.00",
      projected: "900000.00",
      variance_abs: "400000.00",
      variance_pct: "0.33",
      remaining: "400000.00",
      pace_index: "1.10",
    },
    targets: { cpa: { target: "12.00", actual: "10.00", vsTargetPct: "-16.67" } },
    status: "pending",
    pendingCount: 3,
    openAlerts: 1,
    openThreads: 2,
    hasChildren: extra?.hasChildren ?? false,
    expanded: extra?.expanded ?? false,
  };
  return base as QueryRow;
}

function sourceOf(count = 20_000): { source: RowSource; calls: { start: number; end: number }[]; bump: () => void } {
  const calls: { start: number; end: number }[] = [];
  const listeners = new Set<() => void>();
  let dataVersion = "1";
  const source: RowSource = {
    getRows(range) {
      calls.push(range);
      const rows = [];
      for (let index = range.start; index < Math.min(range.end, count); index += 1) {
        rows.push(row(index, { hasChildren: index % 10 === 0, expanded: false }));
      }
      return Promise.resolve({ rows, total: count, dataVersion });
    },
    toggle(nodeKey) {
      return Promise.resolve({ total: nodeKey.length + count });
    },
    subscribe(onInvalidate) {
      listeners.add(onInvalidate);
      return () => listeners.delete(onInvalidate);
    },
  };
  return {
    source,
    calls,
    bump() {
      dataVersion = "2";
      for (const listener of listeners) listener();
    },
  };
}

it("pages the row source in blocks of 200 and prefetches two pages", async () => {
  const { source, calls, bump } = sourceOf();
  const cache = createRowCache(source, { pageSize: 200, prefetch: 2 }, () => undefined);
  expect(cache.get(3)).toBeUndefined();
  await cache.settled();
  expect(calls.map((call) => call.start)).toEqual([0, 200, 400]);
  expect(cache.get(3)?.path.at(-1)).toBe("Brazil-3");
  const fetched = calls.length;
  cache.get(20);
  await cache.settled();
  expect(calls.length).toBe(fetched);

  for (let page = 0; page < 40; page += 1) {
    cache.get(600 + page * 200);
    await cache.settled();
  }
  expect(cache.get(0)).toBeUndefined();
  await cache.settled();
  expect(cache.get(0)?.key).toBe("row-0");

  const beforeInvalidate = calls.length;
  bump();
  await cache.settled();
  expect(calls.length).toBeGreaterThan(beforeInvalidate);
  expect(cache.get(0)?.key).toBe("row-0");
  cache.dispose();
});

it("forwards paste to onPaste and refuses to apply it", () => {
  const pasted: { anchor: { row: number; col: number }; cells: string[][] }[] = [];
  const applied = forwardPaste(
    {
      onEdit: () => Promise.resolve(),
      onPaste: (event) => {
        pasted.push(event);
      },
      onSelect: () => undefined,
    },
    [2, 5],
    [
      ["1.2M", "2"],
      ["3", "4"],
    ],
  );
  expect(applied).toBe(false);
  expect(pasted).toEqual([
    {
      anchor: { col: 2, row: 5 },
      cells: [
        ["1.2M", "2"],
        ["3", "4"],
      ],
    },
  ]);
});

it("builds path, money, pace, target, status, chips, and dimension cells", () => {
  const sample = row(4, { hasChildren: true, expanded: true });
  const columns: ColumnSpec[] = [
    { kind: "path", width: 240 },
    { kind: "measure", key: "budget", editable: true },
    { kind: "measure", key: "pace_index" },
    { kind: "target", metric: "cpa", field: "vsTargetPct", editable: true },
    { kind: "status" },
    { kind: "chips" },
    { kind: "dimension", key: "country" },
  ];
  const cells = columns.map((column) => buildCell(sample, column, { currency: "USD" }));
  expect(cells.map((cell) => ("data" in cell && typeof cell.data === "object" && cell.data !== null && "kind" in cell.data ? cell.data.kind : "dimension"))).toEqual([
    "path",
    "money",
    "pace",
    "target",
    "status",
    "chips",
    "dimension",
  ]);
  for (const cell of cells) {
    expect(cell.copyData).toBeTypeOf("string");
    expect(cell.accessibilityString).toContain("LATAM");
    expect(cell.accessibilityString).toContain("pending");
  }
  const money = cells[1];
  expect(money?.copyData).toBe("1200000.00");
  const pace = cells[2];
  expect(pace?.copyData).toBe("1.10");
  const chips = cells[5];
  expect(chips?.copyData).toBe("");
  const dimension = cells[6];
  expect(dimension?.copyData).toBe("BR");
});

it("parses money, percent, and date editor input", () => {
  expect(parseMoney("1.2M")).toBe("1200000.00");
  expect(parseMoney("1,200,000")).toBe("1200000.00");
  expect(parseMoney("1200000")).toBe("1200000.00");
  expect(parseMoney("nope")).toBeNull();
  expect(parsePercent("12.5%")).toBe("12.50");
  expect(parsePercent("12.5")).toBe("12.50");
  expect(parseDate("2026-09-23")).toBe("2026-09-23");
  expect(parseDate("09/23/2026")).toBeNull();
  expect(editorAction("Enter", false)).toEqual({ type: "commit" });
  expect(editorAction("Escape", false)).toEqual({ type: "cancel" });
  expect(editorAction("Tab", false)).toEqual({ type: "move", movement: [1, 0] });
  expect(editorAction("Tab", true)).toEqual({ type: "move", movement: [-1, 0] });
});

it("has a storybook story for every cell kind", () => {
  const source = readFileSync(join(gridRoot, "cells.stories.tsx"), "utf8");
  for (const kind of CELL_KINDS) {
    expect(source).toContain(`export const ${kind[0]?.toUpperCase()}${kind.slice(1)}`);
  }
  expect(source).toContain("@storybook/react");
});

it("records a BudgetGrid scroll baseline of at least 55 fps p50", () => {
  const baseline = JSON.parse(readFileSync(join(gridRoot, "../bench/baseline.json"), "utf8")) as Record<string, unknown>;
  expect(baseline["budgetGridScrollFpsP50"]).toBeGreaterThanOrEqual(55);
  expect(baseline["budgetGridGetCellP95Ms"]).toBeLessThan(0.2);
  expect(baseline["budgetGridFirstPaintMs"]).toBeLessThan(300);
});
