import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { markerOverlay, markerX, proofBars, PROOF_SCALE, toSvarTasks, visibleLaneRows } from "./spike-layout.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const MS_KEYS = ["cpuScaleMs", "svarRenderP95Ms", "visRenderP95Ms", "canvasRenderP95Ms"] as const;

const FPS_KEYS = ["svarPanFpsP50", "visPanFpsP50", "canvasPanFpsP50"] as const;

const ADR_HEADINGS = ["## Status", "## Context", "## Decision", "## Consequences"] as const;

const BARS = proofBars();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

it("proves a target lane and a marker overlay without the SVAR markers prop", () => {
  const lanes = visibleLaneRows(BARS);
  const budget = lanes.find((row) => row.key === "tgt-budget");
  const envelope = lanes.find((row) => row.key === "env-1");
  expect(budget).toMatchObject({ parentKey: "env-1", kind: "target", lane: 1 });
  expect(envelope).toMatchObject({ lane: 0 });
  expect(lanes.some((row) => row.key === "tgt-cpa")).toBe(false);

  const tasks = toSvarTasks(BARS);
  expect(tasks.find((task) => task.id === "tgt-budget")).toMatchObject({
    parent: "env-1",
    type: "target",
    open: true,
  });
  expect(tasks.find((task) => task.id === "tgt-cpa")).toMatchObject({
    parent: "env-1",
    type: "target",
    open: false,
  });
  expect(tasks.every((task) => !Object.hasOwn(task, "markers"))).toBe(true);

  expect(markerX(PROOF_SCALE, "2026-02-01")).toBeCloseTo(62, 5);
  const overlay = markerOverlay(BARS, PROOF_SCALE, 36);
  const approval = overlay.find((marker) => marker.id === "m-approval");
  const comment = overlay.find((marker) => marker.id === "m-comment");
  const closure = overlay.find((marker) => marker.id === "m-closure");
  expect(approval).toMatchObject({ rowKey: "env-1", y: 0 });
  expect(comment?.clusterId).toBe(approval?.clusterId);
  expect(closure?.clusterId).not.toBe(approval?.clusterId);
  expect((comment?.x ?? 0) - (approval?.x ?? 0)).toBeLessThan(6);
});

it("records the T-026b 5k-bar bench in ADR-003 and the package README", () => {
  const baseline = JSON.parse(readFileSync(join(repoRoot, "packages/timeline/bench/baseline.json"), "utf8")) as unknown;
  expect(isRecord(baseline)).toBe(true);
  if (!isRecord(baseline)) {
    return;
  }
  expect(baseline["bars"]).toBe(5_000);
  expect(baseline["targetLaneProven"]).toBe(true);
  expect(baseline["markerOverlayProven"]).toBe(true);

  const adr = readFileSync(join(repoRoot, "docs/adr/0003-timeline-core.md"), "utf8");
  for (const heading of ADR_HEADINGS) {
    expect(adr).toContain(heading);
  }
  expect(adr).toContain("T-034");
  expect(adr).toContain("target lane");
  expect(adr).toContain("marker overlay");

  for (const key of MS_KEYS) {
    const value = baseline[key];
    expect(typeof value).toBe("number");
    if (typeof value !== "number") {
      return;
    }
    expect(adr).toContain(`${key}: ${value.toFixed(3)}`);
  }
  for (const key of FPS_KEYS) {
    const value = baseline[key];
    expect(typeof value).toBe("number");
    if (typeof value !== "number") {
      return;
    }
    expect(adr).toContain(`${key}: ${value.toFixed(1)}`);
  }

  const decision = /^Rendering engine: (.+)$/m.exec(adr);
  expect(decision?.[1]).toBeTruthy();
  const readme = readFileSync(join(repoRoot, "packages/timeline/README.md"), "utf8");
  expect(readme).toContain(`Rendering engine: ${decision?.[1] ?? ""}`);

  const pkg = JSON.parse(readFileSync(join(repoRoot, "packages/timeline/package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
  expect(names.some((name) => name.startsWith("@svar-ui/") && name.toLowerCase().includes("pro"))).toBe(false);
});
