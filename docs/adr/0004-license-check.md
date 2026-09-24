# ADR-004: Licence check over the pnpm workspace

## Status

Proposed.

## Context

Spec §2 wires `pnpm license-check` to `license-checker-rseidelsohn --production --onlyAllow "…" --excludePrivatePackages`, run from the repo root. The root `package.json` has no production dependencies and every workspace package is private, so the tool prints "No packages found in this path" and exits 0. No licence was ever checked.

Pointing the same tool at each package with `--start` is not enough. It reads `node_modules` the npm way and misses pnpm's transitive dependencies, which live as siblings under `node_modules/.pnpm`. For `apps/api` it reported 14 packages. The real production tree has about 250.

## Decision

`pnpm license-check` runs `scripts/license-check.mjs`. The script:

- takes the production tree of every workspace importer from `pnpm -r licenses list --prod --json`, including transitive dependencies;
- applies the spec §2 allowlist unchanged (`MIT;Apache-2.0;BSD-2-Clause;BSD-3-Clause;ISC;0BSD;CC0-1.0;Unlicense`), where an SPDX `OR` passes if one branch passes and an `AND` passes only if every term does;
- exits non-zero on any disallowed licence, on output it cannot parse, on an empty report, or when a declared non-workspace dependency of `apps/*` or `packages/*` is missing from the report.

`license-checker-rseidelsohn` is removed from the root devDependencies, because nothing uses it any more.

## Consequences

- With the gate working, it fails on the current tree. Six transitive dependencies carry permissive licences that are not on the allowlist: `@csstools/color-helpers` and `@csstools/css-syntax-patches-for-csstree` (MIT-0, via jsdom), `argparse` (Python-2.0, via @nestjs/swagger and nestjs-zod), `caniuse-lite` (CC-BY-4.0, via Glide Data Grid), `lru-cache` (BlueOak-1.0.0, via jsdom and Glide) and `sax` (BlueOak-1.0.0, via svgo). Earlier "`pnpm license-check` green" results in `docs/TASKS_STATUS.md` were not real.
- Still open: whether to widen the allowlist, to add a reviewed per-package exception list, or to replace the dependencies that pull these in. Nobody has decided that yet. Until someone does, the gate stays red.
- Spec §2's dependency table and script line are now out of date. The spec should point to this ADR.
