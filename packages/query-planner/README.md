# @budget/query-planner — Filter compilation and query planning

Compiles FilterGroup AST to SQL, handles group-by and pivot operations, and generates the query plan for `/query`. Implements spec §6 (planner, measures, pivot, as_of).

## Running tests

```bash
pnpm --filter @budget/query-planner test
pnpm bench                                   # grid / timeline / planner benchmarks vs baseline.json
```

Tests cover filter compilation, group-by, pivot, as_of, currency conversion, and measure derivation. Benchmarks ensure query compilation stays under 10% regression.

## Architecture

- `src/compile-filter.ts` — filters to WHERE clauses
- `src/compile-query.ts` — generates the full SELECT statement
- `src/projection.ts` — projection measure optimization (one lateral join per envelope)
- `src/grouping.ts` — group-by + rollup SQL generation
- No interpolation of user strings; all values are bound parameters

The planner never writes SQL outside this package. Changes here require a bench gate and often an ADR.
