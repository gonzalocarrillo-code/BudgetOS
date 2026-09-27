# Local stack (localhost, persistent)

`pnpm dev:local` runs Budget OS on your machine, and it survives restarts.

| What | Where |
|---|---|
| Web | http://localhost:5173 (signed in as the org-wide admin) |
| API | http://127.0.0.1:3000 |
| JWKS (local test issuer) | http://127.0.0.1:4800/jwks |
| Ingest runner | 127.0.0.1:4700 (runs queued ingest runs of the `local` workspace) |

- **Data:** one golden workspace with slug `local`, seeded on the first start and reused after. Your changes stay. `pnpm db:reset` starts over.
- **Sign-in:** tokens are signed by a key kept in `apps/web/e2e/.auth-local/` (gitignored), so they stay valid across restarts.
  - `tokens.json` in that folder has a one-year token for every persona: admin, orgAdmin, planner, budgetOwner, approver, finance1, finance2.
  - The dev server signs in as `orgAdmin`, the org-wide admin (every workspace, the org registry and roles). `LOCAL_PERSONA=admin pnpm dev:local` signs in as the workspace admin instead, or any other persona. Sign out, then paste another persona's token to act as them.
- **Closing a period** works locally (`CLOSURE_SINK=memory`). The frozen rows live only in that API process.
- **Needs:** Postgres and Redis from `packages/db/.env` (and `REDIS_URL`), Node 22.
- **Stop:** Ctrl-C (or stop the "local" preview). The data is kept.
- **The Playwright stack** (`pnpm test:e2e`, `e2e:stack`) is separate: fresh workspace, new key, other ports.

## Roll-up cache (ADR-038)

The Explorer's tree reads `rollup_cache`. Locally, the worker runner (`apps/workers/src/local-runner.ts`) delivers `budget.changed`, `facts.loaded`, `registry.changed` and `naming.changed` to the roll-up worker, so parent totals catch up a few seconds after an edit.

If the tree looks stale:

1. Check the runner is up (`local runner up` in its log).
2. Look for unpublished outbox rows of the workspace.
3. Rebuild the workspace: `pnpm --filter @budget/workers exec tsx src/rollup/main.ts rebuild --workspace <id> --org <id>` with `APP_DATABASE_URL`.

## Query engine (ADR-042)

- `/query` runs on Postgres with the planner, unless the warehouse applies (below). The response's `engine` field says which engine answered: `postgres`, `warehouse` or `cache`.
- Results are cached for 5 minutes. The key covers the workspace, its data version, the day and the scoped query. With `REDIS_URL` set the cache is Redis; without it, memory. `QUERY_CACHE=off` disables it (the load job does this).
- With `BIGQUERY_DATASET=project.dataset` set, a grouped query goes to BigQuery when it spans more than 13 months or Postgres estimates more than 200k rows. The dataset must hold `envelope`, `envelope_version`, `envelope_dimension`, `dimension`, `dimension_value`, `spend_fact` and `projection_fact`, with the Postgres columns. Credentials come from Application Default Credentials. The variable is unset locally.
