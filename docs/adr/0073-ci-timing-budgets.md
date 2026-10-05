# ADR-073: timing budgets scale in CI

## Status

Accepted.

## Context

Several apps/api suites assert a wall-clock budget — T-006's done-when (`golden.test.ts`, the
golden seed in under 60 s; ADR-007's baseline is "about 13 s on a fresh local Postgres 16"), the
Overview under 1.5 s, a 10k-row bulk commit under 10 s, search index lag, Home's first load. W0-1
(audit M-1) is the first time this suite has ever run in CI — before it, every push to `main`
deployed without running any tests.

On GitHub's standard hosted runner several of these fail: the golden seed took 78.7 s on PR #143
(job `111841497731`), comfortably over the local 60 s budget, and the Overview test missed 1.5 s by
19 ms. The runner's cores are shared with the `postgres:16` service container (not available to it
the way a developer's own cores are), and concurrent apps/api test files compete for them further.

Separately, running those same files concurrently (apps/api/vitest.config.mjs's `maxWorkers: 3`,
tuned for a developer machine) surfaced two real bugs that are out of this PR's scope: a Postgres
deadlock in `ensure_fact_partitions` when two sessions both need new monthly partitions at once
(`golden.test.ts`, error code `40P01`), and cross-file data pollution (`rename.test.ts` hit "Envelope
is archived" on a fresh workspace). Both get their own item; W0-1 only needs CI green without
masking either bug by accident.

## Decision

- **Timing budgets scale, they don't change.** `apps/api/src/test-support/perf.ts` exports
  `perfBudgetMs(ms)`, which multiplies by `PERF_BUDGET_SCALE` (default 1). Every wall-clock
  `toBeLessThan(<ms>)` assertion in `apps/api/src/**/*.test.ts` routes through it. `ci.yml`'s `test`
  job sets `PERF_BUDGET_SCALE=3`; unset (developer machines, `pnpm bench`) the numbers are exactly
  the product's own SLAs, unchanged.
- **CI runs apps/api's suites one file at a time.** `apps/api/vitest.config.mjs` reads
  `VITEST_MAX_WORKERS` (default 3); `ci.yml` sets it to `1`. This is a CI-only concurrency setting,
  not a fix for the deadlock or the data pollution — it sidesteps both so this PR can add the gate
  without either bug blocking it or going unnoticed under a scale factor that happens to paper over
  them. Each bug gets its own task; this ADR is not that fix.

Rejected: a bigger (paid) GitHub-hosted runner, out of scope for a CI-gate PR to provision by
itself; loosening or dropping the assertions, since they are recorded done-when SLAs that must keep
meaning something on a developer's machine.

## Consequences

- A genuine performance regression (beyond the 3x CI scale) still fails CI; a regression under 3x
  is caught only locally or in `pnpm bench`.
- `VITEST_MAX_WORKERS=1` makes apps/api's CI run slower (serial instead of 3-way concurrent) but
  deterministic. Fixing the deadlock and the data pollution (each its own task) is what lets CI go
  back to running these files concurrently.
