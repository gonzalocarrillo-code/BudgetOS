# ADR-007: Golden seed generator location and clock

## Status

Accepted.

## Context

Spec §21 puts the generator at `packages/db/seed/golden.ts` and requires it to call the real commands ("never inserts versions directly"). Spec §2 pins `"db:seed": "pnpm --filter @budget/db tsx seed/golden.ts"`, and a domain guard test pins that script.

The commands (envelope create/draft, submit, decide, registry, roles, policies) live in `apps/api`. `@budget/db` cannot import `apps/api`, because api depends on db. The spec also asks for "3 approved versions per leaf across the year" and as-of totals at three dates, but commands stamp `approved_at` with the current time.

## Decision

- **Where the parts live:**
  - `packages/db/seed/golden.plan.ts`: the pure, deterministic plan (seeded mulberry32 PRNG), amounts as `Decimal`.
  - `packages/db/seed/golden.assertions.ts`: the committed literal totals. A test checks they equal `computeTotals(goldenPlan())`.
  - `apps/api/src/seed/golden.ts`: the generator, which calls the commands in-process.
- **The spec script stays unchanged.** `packages/db/seed/golden.ts` runs the api generator in a child process (`pnpm --filter @budget/api seed:golden`). `@budget/db` gets a `"tsx": "tsx"` script, because pnpm 9 reads `pnpm --filter X tsx …` as a script name and otherwise exits 0 without running anything.
- **Clock:** `apps/api/src/common/clock.ts` exports `clock.now()`, and `approveVersion` and request resolution read it. It is real time everywhere except while the seed runs its three approval rounds (2026-01-05, 2026-04-01, 2026-07-01).
- **Direct inserts:** only the organization, workspace, seven users and the first org-wide ORG_ADMIN grant, because no command creates them yet (§27). Everything else goes through commands and is audited.
- **Idempotency:** the seed skips when a workspace with slug `golden` exists; `pnpm db:reset` is the way to start fresh. `--size large` is refused until T-034.

## Consequences

- `pnpm db:seed` takes about 13 s on a fresh local Postgres 16 (330 envelopes, 714 approved versions, about 3,200 audit events).
- Facts, targets, threads, tags, pacing rules and closures are not seeded yet, following LOCAL_BUILD_PHASES phase 9. Each later task adds its rows through its own commands, plus a totals entry in the assertions.
- A test that needs the golden workspace calls `seedGolden()` with its own slug (about 11 s), so tests never share or mutate the `golden` workspace.
