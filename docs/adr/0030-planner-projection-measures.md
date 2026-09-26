# ADR-030: Projection measures in the planner: one lateral per envelope, after the page when possible

## Status

Accepted, 2026-09-26. Not a §22 task. Branch `task/planner-projection-perf`.

## Context

While building T-033's Overview (PR #38), the heat-map query (groupBy `country × platform`, `LIVE_LEAVES`, current year, small golden: ~330 envelopes, no projection facts) took ~575 ms with `projected` and `projected_close_pct` and ~60 ms without them. The Overview now skips those measures unless `projection_fact` has rows.

`compileBase` computed `projected` in the `m` CTE the way spec §6.2 writes it:

```sql
(SELECT coalesce(sum(pf.value_reporting),0) FROM projection_fact pf WHERE … pf.envelope_id = e.id AND pf.period_date BETWEEN …
   AND pf.source_run_id = (SELECT x.source_run_id FROM projection_fact x WHERE … x.envelope_id = e.id ORDER BY x.loaded_at DESC LIMIT 1)) AS projected
```

`EXPLAIN (ANALYZE, BUFFERS)` of both variants showed four problems:

1. **The subquery is copied into every expression that reads `projected`.** `m` and `m2` are inlined, so `projected`, `projected_close_pct`, `variance_*` and a filter on them each get their own copy of the SubPlan. The grouped Overview plan held the projection subqueries 4 times: 152 `projection_fact` partition scans against 38 now.
2. **The inner "latest run" subquery has no period bound.** It plans and probes every monthly partition (35 locally) for every envelope. It reads all of that envelope's rows across all runs, and sorts them by `loaded_at` because there is no index on it.
3. **Planning cost.** 2 subqueries × 35 + 12 partitions × the copies. Cold-connection planning was ~50 ms for the grouped query alone, against ~2 ms without projections.
4. **Nothing short-circuits when the workspace has no projection facts.**

Measured on a 2,000-envelope workspace with 262k projection rows (two runs per envelope, Q1 period): grouped 592 ms, totals 550 ms, flat sorted by `projected` 472 ms. Without projection measures: 85 ms, 67 ms.

What the fix must keep:
- **The spec's semantics.** The latest run is picked over all dates, so a newer run that only projects outside the period wins and projects 0. It is summed over the period. A run split over several loads is still one run.
- **Postgres's deferral of expensive target-list expressions past `Sort + LIMIT`.** The old scalar subquery ran only for the 201 rows of a flat page.

## Decision

- **One `LEFT JOIN LATERAL` per envelope** replaces the scalar subquery in `m`:

  ```sql
  LEFT JOIN LATERAL (
    SELECT (array_agg(r.projected ORDER BY r.loaded_at DESC))[1] AS projected
    FROM (SELECT sum(x.value_reporting) FILTER (WHERE x.period_date BETWEEN $s AND $e) AS projected, max(x.loaded_at) AS loaded_at
          FROM projection_fact x
          WHERE x.workspace_id = $ws AND x.envelope_id = e.id AND x.metric = 'spend'
            AND (SELECT EXISTS (SELECT 1 FROM projection_fact y WHERE y.workspace_id = $ws AND y.metric = 'spend'))
          GROUP BY x.source_run_id) r
  ) p ON TRUE
  ```

  - It reads each envelope's facts once, grouped by run, and keeps the latest run's in-period sum.
  - `projected` is then a plain column (`coalesce(p.projected, 0)`), so copies are free.
  - The lateral returns exactly one row. When no measure, filter or sort reads `projected`, Postgres removes the join, and the plan has no `projection_fact` at all. A test asserts this.
  - The uncorrelated `EXISTS` is an InitPlan evaluated once. In a workspace without projections every partition scan is skipped (`never executed`).
- **`CompileOptions.hasProjections`.**
  - `plannerOptions()` (`@budget/db`) sets it with one `EXISTS` query.
  - When it is `false`, `projected` compiles to `0::numeric` and the SQL has no `projection_fact`, so there is no planning or rescan cost at all.
  - When it is omitted (callers without `plannerOptions`: rollup worker, bulk preview), the `EXISTS` gate above applies.
  - Callers that go through `plannerOptions` (runQuery, pacing, exports, search indexer, pacing worker) get it for free. T-033's own check can be removed once both PRs are in.
  - Read-committed caveat: facts committed between the check and the query read as 0 until the next request. That is the same staleness any read has.
- **Flat pages get projections after the LIMIT.**
  - Applies when the page's sort keys, keyset cursor and filter do not read a projection measure.
  - The page is selected without them. `m.budget` is carried as `tail_budget`.
  - The lateral joins only the page's rows. Columns keep the same names and order.
  - `projectionDerived()` defines `variance_abs`, `variance_pct` and `projected_close_pct` once, for `m2` and for this tail.
  - Sorting or filtering on a projection measure uses the per-envelope lateral in `m`, because the order needs every row.
- **Considered and rejected:**
  - **A set-based CTE** (`DISTINCT ON (envelope_id) … ORDER BY loaded_at DESC` over the workspace, then join). 20% faster on full-workspace groups, but it scans every projection row of the workspace whatever the filter: a 5-envelope filter went from 8 ms to 78 ms.
  - **Two new indexes** (`(workspace_id, envelope_id, metric, loaded_at DESC) INCLUDE (source_run_id)` and `(…, source_run_id, period_date) INCLUDE (value_reporting)`) with the spec's two-step lookup. No gain at 2 or 10 runs per envelope: the lookup still probes every partition per envelope. On the 10-run fixture the planner picked a plan that ran for over 17 minutes. No migration.
  - **A covering index for the set-based scan.** Same plan and time.

Results (interleaved medians, Apple M2, 2026-09-26; old = `main` at 831495f):

| query | old | new |
|---|---|---|
| Overview heat map, golden small, current year, no facts (warm / cold connection) | 95 / 226 ms | 54 / 99 ms (43 / 74 ms without projection measures; with `hasProjections: false` the SQL equals that) |
| grouped, 2,000 envelopes, 262k projection rows | 592 ms | 267 ms |
| totals, same | 550 ms | 259 ms |
| flat page of 1,000 sorted by name, same | 446 ms | 191 ms |
| flat page of 200 sorted by budget (bench `executePage`), same / no facts | 50 / 33 ms | 50 / 34 ms |
| 5-envelope filter, grouped | 10 ms | 7 ms |

Every row and total was identical, old against new, over 14 query shapes on both workspaces. The comparison ran both compilers on the same seeded data.

## Consequences

- **The floor.** With facts, `projected` costs one index probe per monthly partition per envelope (35 locally), plus that envelope's rows. It is picked over all dates because the spec says so, and `projection_fact` is partitioned by `period_date`. It grows with the number of retained runs: projections are snapshots and runs are never deleted (`insertProjectionFacts`).
  - If that becomes the bottleneck, the next step is a per-envelope head pointer maintained at load: `(workspace_id, envelope_id, metric) → latest source_run_id`, like `current_version_id`. It needs its own table, RLS and write path, so it is out of scope here.
- **The bench** (`packages/query-planner/bench/execute.bench.ts`) gains two cases on the Overview query, gated like the others at 10% of the p50 / calibration ratio:
  - `executeProjectionEmpty`: no projection facts, compiled without options, so the `EXISTS` gate path.
  - `executeProjection`: a second workspace with two runs per envelope (`seedBenchProjections`).
- **Baselines** (`bench/baseline.json`).
  - Recorded 2026-09-26 with the ADR-006 method (5 runs), but on a machine at load average 9–17 from other work, which ADR-006 says to avoid.
  - Only what this change moves was updated:
    - `compileToCalibrationP50Ratio` went from 1.018 to 1.1385 (median run). The compiler now builds the lateral and the page tail, about 1 µs more per call.
    - The two new keys use the per-key median of the 5 runs.
  - `executePage` / `executeGroup` / `executeTotals` keep their quiet-machine values from 2026-09-24:
    - Under the same load, `main` itself recorded `executePage` at 0.94–1.25 against 0.7785. So re-recording now would only loosen the gate.
    - Interleaved against `main` on the same data, the page is at parity (0.99), and group and totals are faster.
  - Re-record all keys on a quiet machine before relying on the new ones.
