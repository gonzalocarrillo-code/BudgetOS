# ADR-082: The data version moves at commit, off the workspace row

## Status

Accepted (W3-8, audit I-14).

## Context

Caches key on a per-workspace data version: the `/query` result cache (ADR-042), the tree's
`dataVersion`, the timeline's `x-data-version`, MCP results and exports. Every write path called
`bumpDataVersion()`, an `UPDATE workspace SET settings = jsonb_set(… 'dataVersion' …)` inside its
transaction. The workspace row then stayed locked from the bump to the commit, so the row was a
per-workspace write lock: a 10k-row bulk commit (whose auto-approval bumps again mid-transaction),
or a close waiting on BigQuery, blocked every other write in the workspace until it committed.

The plan (W3-8) offered two ways out:

1. a separate `workspace_data_version` row bumped as the **first** statement of every write, or
2. derive the version on read from `max(outbox.id)` per workspace.

Neither works as written. (1) moves the lock to another row but holds it for the whole
transaction, so a bulk commit still blocks a concurrent single edit, which is the done-when. (2)
takes no lock, but `bigserial` ids are handed out at insert, not at commit: a long transaction
that inserted outbox id 100 and commits after a short one that inserted 101 leaves `max(id)` at
101. A `/query` answer cached between the two commits (without the long write) keeps being served
under that key after the long write lands, for up to the cache TTL. Removing the lock makes exactly
that overlap common.

## Decision

Option (1)'s table, bumped at **commit** instead of first:

- `workspace_data_version (workspace_id pk → workspace on delete cascade, version bigint)`, RLS
  enabled and forced with the usual `tenant_isolation` policy; `budget_app` reads and writes it,
  `budget_mcp` reads it, `budget_publisher` has nothing. Seeded from `settings.dataVersion`.
- A `DEFERRABLE INITIALLY DEFERRED` constraint trigger on `outbox` (after insert, per row) upserts
  `version = version + 1` for the row's workspace. Every write path already emits exactly one
  outbox row in its transaction (AGENTS.md §4), so every committed write moves the version, a
  rolled-back one does not, and no write path calls anything for it: `bumpDataVersion` is gone.
- Deferred, the bump is the last thing a transaction does, inside COMMIT. The row lock is held only
  for the commit itself, and versions increase in commit order (a second committer's bump waits for
  the first's commit and reads its value). Readers read the version before the data, so an answer
  is always at least as new as the version it is cached under.
- `readDataVersion(tx, workspaceId)` in `@budget/db` is the one reader (`/query`, tree, timeline,
  MCP, exports, the roll-up worker).
- `/query` cache keys keep their shape (workspace, data version, day, scoped-query hash) under a new
  prefix `q2:`, so keys from the old counter and the new one never meet while both versions of the
  API run during a deploy.

## Consequences

- A bulk commit no longer blocks a single edit (test: `apps/api/src/modules/envelopes/bulk/data-version.test.ts`
  holds a bulk commit open at its commit and completes an edit in the same workspace meanwhile).
- Outbox rows that are not data changes (thread, tag, alert, notification events) now move the
  version too: some extra cache misses, never a stale hit. The cacheable-filter rule of ADR-042 is
  unchanged.
- A REPEATABLE READ writer (retention's fact prune) gets a serialization failure at commit if
  another write in the workspace committed after its snapshot; it did before too (it updated the
  workspace row), and the next run retries.
- Expand only: the old code keeps writing and reading `workspace.settings.dataVersion`, and its
  writes also bump the new row through the trigger. The new code no longer writes that key; a later
  contract step may strip it from `settings`.
- `workspace_data_version` is in the purge list. A purge's own closing outbox row recreates the
  counter row; it is a counter for a tombstoned workspace and holds no data.
