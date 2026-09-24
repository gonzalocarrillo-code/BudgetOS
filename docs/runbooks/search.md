# Runbook: search (T-020, ADR-014)

- **Indexer:** `apps/workers/src/search-indexer/main.ts` is a Cloud Run push subscriber on every outbox topic. `POST /` takes the push body, and a 500 makes Pub/Sub redeliver. Handling is idempotent per outbox id.
- **Full re-index of a workspace**, after a restore or a registry repair: `pnpm --filter @budget/workers reindex --workspace <id> --org <id>` with `APP_DATABASE_URL`. It rebuilds every type and removes documents whose entity is gone.
- **A document looks stale:** check that the outbox row was published (`published_at`) and that `processed_event` has `search-indexer` for it. Re-indexing the workspace always converges.
- **Facets** (budget, actual, pace, CPA) are for the current fiscal year as of the indexing day.
- **Scope:** results are filtered by the caller's dimension scopes in SQL. A scoped user who can't find an envelope should check their role scope before suspecting the index.
