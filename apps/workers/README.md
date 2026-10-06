# @budget/workers — Worker services

Background job processor deployed as a Cloud Run service on `budgetos-worker`. Implements spec §19 (worker, outbox publisher) and processes asynchronous tasks from the outbox.

## Running tests

```bash
pnpm --filter @budget/workers test
```

Tests require a Postgres database (run `pnpm db:migrate` first). The test suite covers all consumers (ingest, pacing, rollup, search-indexer, notify, export, outbox-publisher).

## Architecture

- `src/local-runner.ts` — main polling loop; subscribes to outbox topics and runs consumers
- `src/*/` — individual workers (ingest, pacing, rollup, search-indexer, notify, export)
- `src/purge/` — workspace lifecycle cleanup
- Workers emit audit events and outbox rows from within a transaction; `published_at` is set only on success

See W1-2 for the polling worker design (ADR-0080).
