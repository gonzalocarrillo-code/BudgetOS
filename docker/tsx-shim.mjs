#!/usr/bin/env node
// Backwards-compatible replacement for `node_modules/.bin/tsx` in the production image (W2-8,
// audit S-10/M-6). `.github/workflows/deploy.yml` (not edited by this change — see the PR) and
// `docs/runbooks/deploy.md` invoke the worker, the migrate job and the MCP server as, e.g.:
//   node_modules/.bin/tsx src/local-runner.ts
//   apps/api/node_modules/.bin/tsx apps/api/src/deploy/bootstrap.ts
//   node_modules/.bin/tsx ../mcp/src/main.ts
// Those commands pass exactly one argument: a path to a `.ts` entry file, relative to the
// caller's cwd. The real `tsx` devDependency is pruned from the production image (it, and the
// rest of devDependencies, is the point of this change), so this file is copied over
// `node_modules/.bin/tsx` in its place. It rewrites that one argument to its compiled `.js`
// sibling (see docker/build-server.sh, which compiles every entry in place rather than into a
// separate `dist/`) and execs plain `node` on it. Internal "@budget/*" resolution is handled
// separately by docker/resolve-hooks.mjs (active globally via NODE_OPTIONS).
import { spawnSync } from "node:child_process";

const [tsPath, ...rest] = process.argv.slice(2);
if (!tsPath || !tsPath.endsWith(".ts")) {
  console.error(`tsx-shim: expected exactly one .ts entry path, got ${JSON.stringify(process.argv.slice(2))}`);
  process.exit(1);
}
const jsPath = tsPath.slice(0, -3) + ".js";
const result = spawnSync(process.execPath, [jsPath, ...rest], { stdio: "inherit" });
if (result.error) {
  console.error(`tsx-shim: failed to start node for ${jsPath}:`, result.error);
  process.exit(1);
}
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
