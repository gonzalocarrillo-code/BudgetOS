import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OUTBOX_TOPICS, topicsFor } from "@budget/domain";
import { describe, expect, it } from "vitest";
import { ROLLUP_TOPICS } from "./rollup/rollup.js";

/**
 * S-001: every outbox topic the code writes is declared in @budget/domain's OUTBOX_TOPICS (the
 * publisher needs a Pub/Sub topic for each, ADR-010), nothing declared is stale, and the workers'
 * own lists agree with it. Reads the source, so a new topic fails here before it fails in GCP.
 */

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const ROOTS = ["apps/api/src", "apps/workers/src", "apps/mcp/src", "packages/db/src", "packages/db/seed", "packages/domain/src", "packages/query-planner/src", "packages/ai/src"];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...(name === "node_modules" ? [] : files(path)));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

/** Topics built at runtime, so the scan cannot see them: each is listed where it is written. */
const DYNAMIC = [
  "tour.completed", // apps/api/src/modules/tours/tours.ts
  "tour.dismissed",
  "facts.pruned", // apps/workers/src/retention/retention.ts
  "uploads.pruned",
];

const written = new Set<string>();
for (const root of ROOTS) {
  let all: string[];
  try {
    all = files(join(repo, root));
  } catch {
    continue; // a package without that folder
  }
  for (const file of all) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/topic:\s*"([a-z_]+(?:\.[a-z_]+)+)"/g)) written.add(m[1] as string);
    for (const m of text.matchAll(/INSERT INTO outbox \(workspace_id, topic, payload\) VALUES \([^,]+, '([a-z_]+(?:\.[a-z_]+)+)'/g)) written.add(m[1] as string);
  }
}

describe("outbox topics (S-001)", () => {
  it("finds the topics the code writes", () => {
    expect(written.size).toBeGreaterThan(30);
    expect(written).toContain("approval.changed");
  });

  it("declares every topic the code writes", () => {
    expect([...written].filter((t) => !(t in OUTBOX_TOPICS)).sort()).toEqual([]);
  });

  it("declares nothing the code no longer writes", () => {
    expect(Object.keys(OUTBOX_TOPICS).filter((t) => !written.has(t) && !DYNAMIC.includes(t)).sort()).toEqual([]);
  });

  it("agrees with the roll-up worker's own list", () => {
    expect(new Set(topicsFor("rollup"))).toEqual(new Set([...ROLLUP_TOPICS, "naming.changed"]));
  });
});
