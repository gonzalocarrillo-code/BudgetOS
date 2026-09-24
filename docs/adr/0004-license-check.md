# ADR-004: Licence check over the pnpm workspace

## Status

Accepted.

## Context

Spec §2 wires `pnpm license-check` to `license-checker-rseidelsohn --production --onlyAllow "…" --excludePrivatePackages`, run from the repo root. The root `package.json` has no production dependencies and every workspace package is private, so the tool prints "No packages found in this path" and exits 0. No licence was ever checked.

Pointing the same tool at each package with `--start` is not enough. It reads `node_modules` the npm way and misses pnpm's transitive dependencies, which live as siblings under `node_modules/.pnpm`. For `apps/api` it reported 14 packages. The real production tree has about 250.

## Decision

`pnpm license-check` runs `scripts/license-check.mjs`. The script:

- takes the production tree of every workspace importer from `pnpm -r licenses list --prod --json`, including transitive dependencies;
- applies the spec §2 allowlist unchanged (`MIT;Apache-2.0;BSD-2-Clause;BSD-3-Clause;ISC;0BSD;CC0-1.0;Unlicense`), where an SPDX `OR` passes if one branch passes and an `AND` passes only if every term does;
- exits non-zero on any disallowed licence, on output it cannot parse, on an empty report, or when a declared non-workspace dependency of `apps/*` or `packages/*` is missing from the report.

A package outside the allowlist passes only when `scripts/license-exceptions.json` has an entry for its exact name, version and licence string, with `via` (the importer) and `reason`. An entry that matches nothing in the production tree fails the check as stale. A version bump or licence change therefore needs a fresh review, and the list cannot silently outlive its packages.

`license-checker-rseidelsohn` is removed from the root devDependencies, because nothing uses it any more.

## Consequences

- The first run of the working gate found six transitive dependencies with permissive licences that are not on the allowlist. They are now reviewed exceptions: `@csstools/color-helpers` 6.1.1 and `@csstools/css-syntax-patches-for-csstree` 1.1.14 (MIT-0, via jsdom), `argparse` 2.0.1 (Python-2.0, via @nestjs/swagger and nestjs-zod), `caniuse-lite` 1.0.30001810 (CC-BY-4.0, via Glide Data Grid), `lru-cache` 11.5.3 (BlueOak-1.0.0, via jsdom and Glide) and `sax` 1.6.1 (BlueOak-1.0.0, via svgo). The allowlist itself is unchanged.
- Earlier "`pnpm license-check` green" results in `docs/TASKS_STATUS.md` were not real.
- A lockfile update that bumps an excepted package, for example `caniuse-lite`, turns the gate red until someone reviews the new version and updates its entry.
- Spec §2's dependency table and script line are now out of date. The spec should point to this ADR.
