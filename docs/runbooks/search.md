# Runbook: search (T-020, ADR-014)

- **Indexer:** `apps/workers/src/search-indexer/main.ts` is a Cloud Run push subscriber on every outbox topic. `POST /` takes the push body, and a 500 makes Pub/Sub redeliver. Handling is idempotent per outbox id.
- **Full re-index of a workspace**, after a restore or a registry repair: `pnpm --filter @budget/workers reindex --workspace <id> --org <id>` with `APP_DATABASE_URL`. It rebuilds every type and removes documents whose entity is gone.
- **A document looks stale:** check that the outbox row was published (`published_at`) and that `processed_event` has `search-indexer` for it. Re-indexing the workspace always converges.
- **Facets** (budget, actual, pace, CPA) are for the current fiscal year as of the indexing day.
- **Scope:** results are filtered by the caller's dimension scopes in SQL. A scoped user who can't find an envelope should check their role scope before suspecting the index.

# Roll-up cache (T-022, ADR-016)

- **Service:** `apps/workers/src/rollup/main.ts` is a push subscriber for `budget.changed`, `facts.loaded` and `registry.changed`.
- **Full rebuild of a workspace:** `pnpm --filter @budget/workers rollup:rebuild --workspace <id> --org <id>` covers every template for the current fiscal year and the cached periods.
- **A node looks wrong:** compare it with the live pivot, which is a planner `groupBy` of the template path over `is_leaf = true AND status <> ARCHIVED`. They are computed the same way. A mismatch means an event was missed, and a rebuild converges.
- **Settings (T-041, ADR-036):** admin pages come from `SETTINGS` in `@budget/domain/settings.ts`. They are indexed on `workspace.created` and on every full re-index. After adding an entry, or for a workspace created before T-041, re-index the workspace.

## At scale (ADR-043)

- Each type ranks and counts at most 1,000 matches. Beyond that the response says `more: true` and ⌘K shows "1000+".
- Typos are corrected against `search_term`, the workspace's distinct words, which a trigger on `search_document` keeps current. The correction only runs when nothing matches exactly.
- `search_term` is derived data. If it is ever lost, rebuild it with the backfill statement in migration `20260929000000_search_term`.
