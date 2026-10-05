# ADR-0072: Bulk-edit and budget-import previews in Postgres

## Status

Accepted.

## Context

Audit finding I-5 (`docs/STACK_AUDIT_2026-10-04.md`): `budgetos-app` runs with more than one
instance, but ADR-008 chose a `PreviewStore` that is Redis in every deployed environment and
per-process memory otherwise. Port 6379 belongs to another project on the development machine, so
Redis was never actually deployed; W0-4 pinned the service to one instance (`--max-instances 1`)
as a stop-gap so a preview built on instance A could still be committed from instance A.

Decision D-2 (`docs/STACK_HARDENING_PLAN.md`, Wave 5) asks: Memorystore, or the Postgres store
this item (W1-5) builds, as the long-term fix — and, separately, whether Memorystore is also worth
it for the `/query` result cache and the MCP rate limiter, both still per-instance. The product
owner's decision: no Memorystore. One more managed service (VPC connector, another Terraform
module, another thing to keep patched) isn't worth it for state this small and this short-lived.

## Decision

- **Previews move to Postgres.** A new table, `bulk_preview(id, workspace_id, author_id, kind,
  payload, created_at, expires_at)`, RLS-scoped exactly like every other tenant table
  (`workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[])`, `ENABLE`+`FORCE ROW LEVEL
  SECURITY`). `budget_app`'s CRUD comes from the `ALTER DEFAULT PRIVILEGES` already in
  `0001_roles`; it is not granted to `budget_mcp` — a preview is write-path staging, not a
  read-only query concept `apps/mcp` exposes.
- **`PreviewStore.put`/`get`/`take`/`delete` take the active tenant transaction** (`Tx`, i.e.
  `Prisma.TransactionClient`), so the Postgres implementation runs inside the caller's
  `withTenant()` and reads `app.workspace_id` / `app.user_id` from the transaction's own session
  settings rather than being passed them — a call outside a tenant transaction fails loudly (NOT
  NULL) instead of writing under the wrong tenant. `MemoryPreviewStore` and `RedisPreviewStore`
  both ignore the transaction; they are kept, unchanged in behavior, for tests
  (`PREVIEW_STORE=memory`) and for local/dev parity with pre-ADR-0072 deploys
  (`PREVIEW_STORE=redis` with `REDIS_URL` set).
- **`previewStoreFromEnv` defaults to Postgres.** `PREVIEW_STORE=redis` (with `REDIS_URL`) keeps
  selecting Redis; `PREVIEW_STORE=memory` selects the in-process store; anything else, including
  `REDIS_URL` set on its own, is Postgres. `REDIS_URL` alone no longer opts a deployed environment
  into Redis — Postgres is the default everywhere, which is the whole point of this ADR.
- **`take` is `DELETE … RETURNING payload` in one statement.** `commitBulk` and
  `commitBudgetImport` call it as the first thing inside their write transaction, so a second,
  concurrent commit of the same preview can never also pass the "preview exists" check: the first
  delete-and-returns the row, the second sees nothing and gets the existing "Preview not found or
  expired; preview again" (404). `buildPreview` and `previewBudgetImport` call `put` from inside
  their own transaction, after computing the preview, rather than after it commits — previews are
  not a business write (no audit, no outbox; ADR-008 didn't require them either), so this is only
  about giving the Postgres call a `Tx` to run on.
- **No separate sweeper.** `deleteExpiredPreviews` deletes the calling session's own expired rows
  (RLS already scopes it to the session's workspace); `putPreview` calls it before every insert.
  Previews are small (one JSON row per bulk edit or import, 30-minute TTL) and short-lived, so a
  table that is swept every time someone starts a new preview stays bounded without a worker pass.
  This item does not touch `apps/workers/src/local-runner.ts` (W1-2's file); `bulk_preview` is
  added to the workspace purge's `OWN` table list in `apps/workers/src/purge/purge.ts` so a purged
  workspace's stray rows go with it.
- **The `/query` result cache and the MCP rate limiter stay per-instance.** Both already degrade
  safely: the `/query` cache key includes the workspace's `dataVersion`
  (`docs/runbooks/local.md`, ADR-042), so a cache hit on the "wrong" instance is bounded by how
  stale that instance's view of `dataVersion` is, not unbounded — and a write that bumps
  `dataVersion` invalidates every instance's key on its next read, cache or not. The MCP rate
  limiter being per-instance only ever under-counts across instances (allows a little more than
  the nominal limit with 3 instances, never less and never incorrectly rejects), which is an
  acceptable failure mode for a limiter, unlike a preview silently 404ing on the wrong instance.
  Neither needed the correctness guarantee previews did.
- **`W0-4`'s `--max-instances 1`** on `budgetos-app` is no longer needed once this merges; raising
  it back to 3 in `deploy.yml` is out of scope for this PR (left to the orchestrator, per the
  hardening plan's sequencing).

## Consequences

- A preview now costs one extra round trip inside the preview/commit transaction instead of a
  Redis call outside it; both were already inside a `withTenant()` for everything else, so the
  transaction's shape is barely different, and the set-based commit (ADR-008) is unchanged.
- Previews are visible to `SELECT` under `withTenant` like any other tenant row, which makes them
  debuggable in a way an opaque Redis key wasn't (an operator can read `bulk_preview` directly in
  an incident) — at the cost of one more table, purely operational and uninteresting outside one.
- `ADR-008`'s Redis requirement is superseded by this ADR; its set-based commit SQL and phasing
  decisions stand unchanged.

## Supersedes

[ADR-008](0008-bulk-previews-redis.md) (the "every deployed environment needs Redis" part only;
the commit SQL and phasing decisions in ADR-008 are unchanged).
