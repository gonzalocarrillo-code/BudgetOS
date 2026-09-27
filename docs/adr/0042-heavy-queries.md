# ADR-042: Heavy queries: warehouse routing and a query cache

## Status

Accepted.

## Context

Spec §6.2 has a routing rule: heavy queries run on BigQuery. T-007 deferred it and it was never built.

The full-scale load run (T-034, run 36310988660) measured:

- pivot: 9.5 s;
- grid p95: 9.2 s.

Product direction (2026-09-27): spend and projected spend come from the client's warehouse (BigQuery or Snowflake), read only. Postgres stays the application's store. The decision was "analytics reads only": heavy spend reads run in the warehouse, not recomputed in Postgres.

## Decision

- **Warehouse routing** (`runQuery`, `engine.ts`).
  - This applies when `BIGQUERY_DATASET` is set and the query is a grouped shape the BigQuery dialect supports (`compileAggregateBq` / `compileAggregateTotalsBq`):
    - base measures only;
    - no `asOf`, KPI targets or template;
    - filters on dimension predicates, status and is_leaf.
  - The query runs on BigQuery when the period spans more than 13 months or `EXPLAIN` estimates more than 200k rows. Otherwise it runs on Postgres. Without the variable everything runs on Postgres.
  - The dialect computes as sets: budget, spend and projected spend per envelope, joined, then grouped. It returns the columns, order keys and cursor of `compileQuery` / `compileTotals`.
  - Read scope is part of the filter, so row-level permissions apply on either engine.
  - The warehouse is read only: this path never writes to it.
- **Query cache.**
  - Responses are cached in Redis (in memory without `REDIS_URL`) for 5 minutes.
  - The key is workspace, data version, today and a hash of the scoped query. Any write that bumps the data version therefore invalidates the entry.
  - Filters on tags, threads or mentions are not cached, because those change without a bump.
  - `engine` in the response reports `postgres`, `warehouse` or `cache`.
- **Postgres keeps the per-envelope planner.** A set-based Postgres planner (the dialect's shape) was built, proved equal to the per-envelope planner, and measured at 100 shards. It was dropped:
  - **As joins of sets:** fast on analysed data (pivot 460 ms). Postgres plans from estimates, though, and under RLS, or on a freshly loaded workspace, it estimates the selection at a few rows. A nested loop over every fact row followed: leaf-page totals took 3.2 s; the pivot took 97 s, and 118 s on a new workspace.
  - **As per-envelope index lookups** (safe whatever the estimates): the same cost as the per-envelope planner (pivot about 950 ms). The roll-up rebuild was 32–42 s against 25.5 s before.

  BigQuery has no such planning risk, so the set-based shape lives only in its dialect.

## Consequences

- The BigQuery dataset must mirror the tables the dialect reads. Loading that replica (or pointing the dialect at the client's Snowflake or BigQuery views) belongs to the ingestion work (T-017). It needs the client's credentials.
- The dialect is checked for syntax, the workspace cut and parameters. Checking it for equal answers against a real replica is part of T-017.
- `asOf` queries and tag filters stay on Postgres.
- On Postgres, grid latency at full scale is unchanged by this ADR.
