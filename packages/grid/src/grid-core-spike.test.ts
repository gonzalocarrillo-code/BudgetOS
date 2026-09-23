import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const MS_KEYS = [
  "cpuScaleMs",
  "glideVisibleWindowP50Ms",
  "tanstackVisibleWindowP50Ms",
  "glideGetCellMedianMs",
  "tanstackGetCellMedianMs",
  "glideModelBuildMs",
  "tanstackModelBuildMs",
] as const;

const FPS_KEYS = ["glideScrollFpsP50", "tanstackScrollFpsP50"] as const;

const ADR_HEADINGS = ["## Status", "## Context", "## Decision", "## Consequences"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

it("records the T-026a grid-core bench in ADR-002 and the package README", () => {
  const template = readFileSync(join(repoRoot, "docs/adr/0000-template.md"), "utf8");
  for (const heading of ADR_HEADINGS) {
    expect(template).toContain(heading);
  }

  const baseline = JSON.parse(
    readFileSync(join(repoRoot, "packages/grid/bench/baseline.json"), "utf8"),
  ) as unknown;
  expect(isRecord(baseline)).toBe(true);
  if (!isRecord(baseline)) {
    return;
  }
  expect(baseline["rows"]).toBe(100_000);
  expect(baseline["columns"]).toBe(12);

  const adr = readFileSync(join(repoRoot, "docs/adr/0002-grid-core.md"), "utf8");
  for (const heading of ADR_HEADINGS) {
    expect(adr).toContain(heading);
  }
  expect(adr).toContain("T-034");

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
  const readme = readFileSync(join(repoRoot, "packages/grid/README.md"), "utf8");
  expect(readme).toContain(`Rendering engine: ${decision?.[1] ?? ""}`);
});
