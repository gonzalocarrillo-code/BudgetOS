# ADR-034: Golden seed speed: fewer round trips, same commands, same data

## Status

Accepted, 2026-09-26. Not a §22 task. Branch `task/golden-seed-speed`.

## Context

`apps/api/src/seed/golden.test.ts` asserts the T-006 done-when, "seeds through the commands in under 60 seconds". Each task since has added seed steps (T-036 naming, T-038 experiments). Under the full local suite (`turbo run test --concurrency=1`, three API test files at a time, each seeding its own golden workspace) the seed took 63–69 s. Alone it took about 41 s on the developer database, against about 13 s in ADR-007.

The seed now logs the seconds each phase took. Profile on 2026-09-26 (Apple M2, load average 6–10 from other work, so wall times are ±20%):

| phase | dev DB | fresh DB |
|---|---|---|
| envelope tree, 5 levels, 330 create + submit + decide | 14–18 s | 9–12 s |
| re-plan rounds 2 and 3 (192 leaves each) | 6 s | 5–6 s |
| pacing, 3 evaluations | 5.0 s | 0.8 s |
| rollup rebuild, 3 templates | 3.9–6.2 s | 0.7–1.6 s |
| closure + restate | 3.2–4.8 s | 1.8–2.1 s |
| ingest | 1.4–2.5 s | 0.7–0.9 s |
| search re-index | 1.6 s | 0.5–0.6 s |
| **total** | **34–42 s** | **21.6 s** |

"Fresh DB" is a new database in the same container, migrated with `prisma migrate deploy`.

Two different causes:

1. **The worker phases are slow only on the developer database.** Its fact-partition indexes are bloated by repeated local test and load runs: `spend_fact_202602_workspace_id_envelope_id_period_date_idx` has 3,382 pages for 2,688 rows, and each fact partition is about 90 MB for about 2.7k rows. So the pacing planner query took 1,447 ms. After `REINDEX` of the fact partitions (in a rolled-back transaction) it took 128 ms. This is local state, not code, and CI starts from an empty database.
2. **The envelope tree and rounds are bound by round trips.** At concurrency 1 a create is about 30 statements, a submit 27 and a decide 21–29, at about 0.5 ms each. Every `withTenant()` transaction adds five more: `BEGIN`, `SET TRANSACTION ISOLATION LEVEL`, four `set_config` calls counted as four, and `COMMIT`. On top of that the seed re-read each approval request after every step (3 reads per request) and each envelope's head before every re-plan.

## Decision

- **The seed keeps going through the real commands.** It uses the same commands, personas, order and golden data, and `golden.assertions.ts` is unchanged. The changes only drop reads the seed can derive:
  - **One read per approval request.** The policy chain is frozen on the request at submit, and `decide` returns the request's status. So the seed reads the snapshot once and walks its remaining steps, `minApprovals` deciders each, and asserts that the last decision returns `APPROVED`. It no longer re-reads after every decision.
  - **Heads tracked in memory.** The version the seed just approved is the envelope's current version. The re-plan rounds and the split pass it as `basedOnVersionId` instead of reading `envelope.current_version_id` back. The commands still check it (`assertBasedOnHead`), so a wrong head would fail loudly with 409.
  - **Phase timings.** Every `log()` line ends with the seconds since the previous line, so the seed profiles itself (`pnpm db:seed` prints them).
- **`withTenant()` sets its four settings in one statement.** `SELECT set_config('app.workspace_id', $1, true), set_config('app.org_id', $2, true), set_config('app.user_id', $3, true), set_config('app.is_org_admin', $4, true)` replaces spec §4's one statement per setting. The settings, their transaction scope and their values are the same, and the RLS and tenant-isolation tests pass unchanged. Every command and worker transaction saves three round trips. Measured on 8 concurrent clients, an empty tenant transaction went from 0.44 ms to 0.27 ms. This deviates from spec §4's code, which is why this ADR exists.
- **Result (fresh DB, same data):**

  | | before | after |
  |---|---|---|
  | SQL statements | 96,098 | 73,956 (−23%) |
  | transactions | 4,912 | 3,429 (−30%) |
  | seed wall time | 21.6 s | 15.8 s |

- **Considered and not done:**
  - **Batching approvals per level** (create a level, submit all, then decide step by step for all). It issues the same number of transactions as the per-envelope walk and would change the order of audit events. It gains nothing without a batch decide command, and the spec has none.
  - **`m AS MATERIALIZED` in the planner.** The `budget` and `actual` scalar subqueries are copied into every `m2` expression that reads them, which is ADR-030's problem 1 for the other measures: the pacing plan held 14 aggregate subplans per row. Materializing halves that query on a bloated database, but it stops the outer filter from being pushed into `m`, so a 5-envelope filter would compute every envelope of the workspace. The fix is ADR-030's lateral approach for `budget` and `actual`. That is planner work with its own bench gate, so it is left out of this PR.
  - **Lazy scope targets.** `envelopeScopeTarget()` costs three queries per call even when every assignment of the caller is unscoped, as with all seed personas. Skipping it needs a change at about 60 call sites. It is a follow-up.
  - **Raising the seed's concurrency above 8.** It helps alone, but three test files seed at once under the suite on an 8-core laptop. It is not reliable.
  - **Parallel rollup templates, or pacing work in batches.** On a healthy database those phases are under 1–2 s each.

## Consequences

- The seed does about 23% less database work, and every request saves three round trips per transaction.
- **The developer database needs index maintenance.** When the suite gets slower over weeks, rebuild the fact indexes, or start from a clean database with `pnpm db:reset`:

  ```sql
  REINDEX TABLE spend_fact; REINDEX TABLE kpi_fact; REINDEX TABLE projection_fact;
  ```

  On a partitioned table, `REINDEX TABLE` rebuilds every partition's indexes.
- The 60 s check measures the whole machine. Under the full suite, three golden seeds run at once, so a busy laptop or a bloated database can still push one over 60 s. CI starts empty.
