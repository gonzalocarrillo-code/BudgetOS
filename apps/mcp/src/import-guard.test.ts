import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * T-025 CI guard (spec §16, ADR-019), no database, run by CI: nothing the MCP server imports,
 * directly or through the API's read barrels (@budget/api/queries, @budget/api/auth), is a
 * `commands/` module, and from @budget/db it takes only withTenant and audit (its one write,
 * the per-call audit row). A tool that mutates would have to break one of these.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const apiSrc = join(repo, "apps/api/src");
const mcpSrc = join(repo, "apps/mcp/src");
const ENTRIES: Record<string, string> = { "@budget/api/queries": join(apiSrc, "queries.ts"), "@budget/api/auth": join(apiSrc, "common/auth/index.ts") };
const IMPORT = /(?:import|export)\s[^"';]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "test-support" ? [] : sources(p);
    return p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });
}

/** Every file reachable from `entries` through relative imports and the @budget/api read barrels. */
function reachable(entries: string[]): { files: Set<string>; forbidden: string[] } {
  const files = new Set<string>();
  const forbidden: string[] = [];
  const stack = [...entries];
  while (stack.length) {
    const file = stack.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const spec = (m[1] ?? m[2] ?? m[3]) as string;
      let target: string | null = null;
      if (spec === "@budget/api" || (spec.startsWith("@budget/api/") && !(spec in ENTRIES))) forbidden.push(`${relative(repo, file)} imports ${spec}`);
      else if (spec in ENTRIES) target = ENTRIES[spec] as string;
      else if (spec.startsWith(".")) target = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
      if (target === null) continue;
      if (!existsSync(target)) target = target.replace(/\.ts$/, "/index.ts");
      if (target.includes("/commands/")) forbidden.push(`${relative(repo, file)} → ${relative(repo, target)}`);
      stack.push(target);
    }
  }
  return { files, forbidden };
}

const DB_ALLOWED = new Set(["withTenant", "audit"]);

describe("read-only MCP imports (T-025 CI guard)", () => {
  it("nothing reachable from apps/mcp/src is a commands/ module", () => {
    const { files, forbidden } = reachable(sources(mcpSrc));
    expect(forbidden).toEqual([]);
    // The walk really goes through the API's query modules.
    expect([...files].some((f) => f.includes("/apps/api/src/modules/query/queries/run-query.ts"))).toBe(true);
    expect(files.size).toBeGreaterThan(20);
  });

  it("the walk would catch a command import (self-test)", () => {
    expect(reachable([join(apiSrc, "modules/envelopes/envelopes.service.ts")]).forbidden.length).toBeGreaterThan(0);
  });

  it("apps/mcp/src takes only withTenant and audit from @budget/db", () => {
    const used = sources(mcpSrc).flatMap((f) =>
      [...readFileSync(f, "utf8").matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+["']@budget\/db["']/g)].flatMap((m) =>
        m[1] ? [] : (m[2] ?? "").split(",").map((x) => x.trim()).filter((x) => x && !x.startsWith("type ")).map((x) => `${relative(repo, f)}: ${x}`),
      ),
    );
    expect(used.filter((u) => !DB_ALLOWED.has(u.split(": ")[1] as string))).toEqual([]);
    expect(used.length).toBeGreaterThan(0);
  });
});
