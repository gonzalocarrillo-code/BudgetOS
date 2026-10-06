#!/bin/sh
# Compiles the server-side TypeScript to plain JavaScript for the production image (W2-8, audit
# S-10/M-6). Each package keeps its existing tsconfig.json (used unchanged by `pnpm typecheck`,
# which always passes --noEmit) and gets a sibling tsconfig.build.json that only flips
# "noEmit" off and points "outDir" back at the package's own "src" (or, for @budget/db, at "."
# so packages/db/seed — a second root its src/ imports from — compiles too). Compiling IN PLACE,
# next to the .ts files, means every package's build output always has the exact same shape as
# its source tree: no separate dist/ layout to keep in sync, and the runtime resolve hook
# (docker/resolve-hooks.mjs) only ever has to swap a ".ts" extension for ".js".
#
# Order follows the dependency graph purely for readable failures; a plain `tsc -p` (no project
# references/composite build) type-checks across package boundaries straight from source
# exactly as `pnpm typecheck` already does, so the order doesn't affect correctness.
set -eu
cd "$(dirname "$0")/.."
TSC=./node_modules/.bin/tsc

for pkg in packages/domain packages/query-planner packages/db packages/ai apps/workers apps/api apps/mcp; do
  echo "==> tsc -p $pkg/tsconfig.build.json"
  "$TSC" -p "$pkg/tsconfig.build.json"
done
