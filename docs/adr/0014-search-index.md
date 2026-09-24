# ADR-014: Search index, scope and suggest

## Status

Accepted.

## Context

T-020 (spec §12, plan §11.3) adds the search indexer and the search and suggest API. The local gate is index lag under 5 s on the small golden seed plus the suggest API. The p95 under 150 ms at 1M documents is the T-034 load job. Three points needed deciding:

- Spec §12.3 writes the search SQL in `apps/api`. AGENTS.md keeps SQL strings in `packages/db` and `packages/query-planner`.
- Plan §11.3 says "a user only sees results they could open". RLS on `search_document` is per workspace, and dimension scopes live in the app.
- The spec's `buildEnvelopeDocument` computes facets with the planner for `current_quarter`. Annual budgets read wrong against a quarter (ADR-012).

## Decision

- **Where the SQL lives:**
  - `compileSearch` (in `@budget/query-planner`) builds the spec §12.3 query.
  - The upsert, delete and id-listing statements are in `@budget/db` `search.ts`.
  - The API only parses the request, calls those and shapes the response.
- **Scope in SQL.** The caller's `envelope.read` assignments are compiled into the WHERE clause over `dimension_values`: `eq` / `in` on the code, `descends_from` through the registry's ltree path. An unscoped role (or an org admin) gets no condition.
  - Documents without a dimension scope (tags, registry values) are visible to every workspace member.
  - Comments carry their anchor envelope's dimensions, so a scoped user doesn't see comments on envelopes outside their scope.
- **Documents.** Seven types are indexed: envelope, target, approval request, alert, comment, tag, dimension value.
  - Envelope bodies carry rationales, dimension labels, aliases and external ids.
  - Envelope facets (budget, actual, pace, CPA, CPA target) come from one planner query per batch for the **current fiscal year**. The spec's single-envelope query by `name` is batched with `name IN (…)`.
  - Status is stored upper-case for every type.
  - `period_key` is `FY2026`, `2026-Q3` or `2026-07` when the dates are exactly that period.
- **Events.** `search-indexer` handles every outbox topic through `handleOnce` and rebuilds the documents the event names:
  - `budget.changed`, including bulk version ids, split / merge ids and bulk change ids;
  - `facts.loaded`, `target.changed`, `approval.changed`, `alert.*`;
  - `thread.changed`: the comment, or the whole thread on resolve / reopen;
  - `tag.changed`: the tag, the merged-away tag, and every entity it carries;
  - `registry.changed`: the dimension's values and the envelopes a merge rewrote.

  Deleted comments and merged-away tags lose their document.
- **Full re-index.** `reindexWorkspace` rebuilds all seven types, batching upserts by 1,000, and removes documents whose entity is gone. It runs at the end of the golden seed, so `pnpm db:seed` gives a searchable workspace. On the CLI: `pnpm --filter @budget/workers reindex --workspace <id> --org <id>`.
- **Qualifiers** are the spec set, plus:
  - `cpa:>target`, which compares the CPA facet with the CPA target facet;
  - `has:open-thread`, which matches any open thread on the entity, cell threads included;
  - type aliases (`approval`, `request`, `value`, `dimension`).

  Numeric and relative-date values are validated (422). Dimension qualifiers compare case-insensitively.
- **Suggest** reads the registry live: qualifier keys (the fixed set plus every visible dimension key), or up to ten values after `key:`. A new dimension is therefore a qualifier on the next call, which is Epic 0.4's "within 10 seconds".

## Consequences

- Index lag is proven locally from command commit to searchable through the real outbox rows and indexer. Pub/Sub transport latency is measured in phase 20.
- Still open:
  - `approver:@me`, recents and pins, and the People, Saved views, Reports and Admin page types (T-041 adds admin pages);
  - the Meilisearch swap (`SearchProvider`);
  - semantic search, which is plan phase 2;
  - list-partitioning `search_document` by workspace, which is left for the T-034 load job.
