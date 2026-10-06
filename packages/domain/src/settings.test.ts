import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { SETTINGS } from "./settings.js";

/**
 * HF-1 (audit T-5 follow-up): a settings-registry entry whose path has no route file is a dead
 * link in global search — R11-004 (commit 9d299b8) removed /admin/templates and left two entries
 * (14 "Workspace templates", 15 "Demo data") still pointing at it. Every entry's path, with its
 * query string and hash stripped, must resolve to a TanStack Router file under apps/web/src/routes
 * named `w.$ws.<segments>.tsx` (spec §18, file-based routing).
 */
const routesDir = join(dirname(fileURLToPath(import.meta.url)), "../../../apps/web/src/routes");

function routeFileFor(path: string): string {
  const pathname = path.split(/[?#]/)[0] as string;
  const segments = pathname.split("/").filter(Boolean);
  return `w.$ws.${segments.join(".")}.tsx`;
}

it("every setting points at a path with a route file", () => {
  const files = new Set(readdirSync(routesDir));
  const missing = SETTINGS.map((s) => ({ title: s.title, path: s.path, file: routeFileFor(s.path) })).filter((s) => !files.has(s.file));
  expect(missing).toEqual([]);
});

it("no longer lists Workspace templates (R11-004: creating workspaces moved to the org console)", () => {
  expect(SETTINGS.some((s) => s.title === "Workspace templates")).toBe(false);
});

it("Demo data opens the workspace settings page, at its own section", () => {
  const demo = SETTINGS.find((s) => s.title === "Demo data");
  expect(demo?.path).toBe("/admin/workspace#demo-data");
});
