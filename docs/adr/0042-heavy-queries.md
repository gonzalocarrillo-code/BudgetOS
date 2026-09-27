# ADR-042: Heavy queries: set-based planner, warehouse routing, query cache

## Status

Accepted.

## Context

Spec §6.2 has a routing rule: heavy queries run on BigQuery. T-007 deferred it and it was never built.

The full-scale load run (T-034, run 36310988660) measured:

- pivot: 9.5 s;
- grid p95: 9.2 s.

The per-envelope planner evaluates one correlated subquery per envelope for budget, spend and projected spend, and then groups the results. At 1M envelopes that is the cost.

Product direction (2026-09-27): spend and projected spend come from the client's warehouse (BigQuery or Snowflake), read only. Postgres stays the application's store. The decision was "analytics reads only": heavy spend reads run in the warehouse, not recomputed in Postgres.

## Decision

- **Set-based planner** (`compileAggregate`, `compileAggregateTotals` in `@budget/query-planner`).
  - Grouped and total queries are computed as sets:
    - the selected envelopes;
    - each envelope's latest approved budget as of the instant;
    - spend (`spend_month` for whole months, `spend_fact` for the edges, ADR-037);
    - the latest projection run;
    - then one join and one GROUP BY.
  - It returns exactly what the per-envelope planner returns: the same columns, order keys and cursor. A test asserts this across group-bys, filters, sorts, `asOf`, mid-month periods and paging.
  - It covers grouped and total queries whose filter reads dimensions and envelope attributes. Queries with measure filters, KPI targets, templates, flat pages or envelope scopes keep the per-envelope planner.
  - The roll-up worker's full build uses it.
- **Warehouse routing** (`runQuery`, `engine.ts`).
  - This applies when `BIGQUERY_DATASET` is set and the query is a grouped shape the BigQuery dialect supports (`compileAggregateBq`: no `asOf`; dimension predicates, status and is_leaf).
  - The query runs on BigQuery when the period spans more than 13 months or `EXPLAIN` estimates more than 200k rows.
  - Otherwise it runs on Postgres. Without the variable everything runs on Postgres.
  - Read scope is part of the filter, so row-level permissions apply on either engine.
  - The warehouse is read only: this path never writes to it.
- **Query cache.**
  - Responses are cached in Redis (in memory without `REDIS_URL`) for 5 minutes.
  - The key is workspace, data version, today and a hash of the scoped query. Any write that bumps the data version therefore invalidates the entry.
  - Filters on tags, threads or mentions are not cached, because those change without a bump.
  - `engine` in the response reports `postgres`, `warehouse` or `cache`.

## Consequences

- The BigQuery dataset must mirror the tables the dialect reads. Loading that replica (or pointing the dialect at the client's Snowflake or BigQuery views) belongs to the ingestion work (T-017). It needs the client's credentials.
- `asOf` queries and tag filters stay on Postgres.
- A new measure has to be added to both planners, and to the equality test.
