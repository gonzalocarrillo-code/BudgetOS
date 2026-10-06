# Runbook: the worker (`budgetos-worker`, W1-2, ADR-010 Decision D-3, ADR-065)

## What it is

`budgetos-worker` runs `apps/workers/src/local-runner.ts` as an always-on Cloud Run service
(`--min-instances 1 --max-instances 1`, see `.github/workflows/deploy.yml`). **This poll loop is
the production design for the single-org deployment** — not a stand-in for the at-least-once
Pub/Sub publisher/push path spec §19 describes (`outbox-publisher.ts`, `consumer.ts`'s push
subscriptions). That path stays in the codebase, typechecked, for the multi-tenant design, but is
not deployed; ADR-010 and ADR-065 both record this as Decision D-3 (2026-10-05).

The loop polls the `outbox` table once a second (or immediately while a poll found rows) for every
workspace in its scope — the org of the workspace slugged `LOCAL_ORG_FROM`, else every workspace
whose slug starts with `LOCAL_WORKSPACE_PREFIX` (empty in production, so every workspace; `e2e-` for
the Playwright stack). For each unpublished, non-dead-lettered row past its backoff, it runs the
ingest, roll-up, search-indexer, in-app notify, Slack notify and export consumer families that apply
to that row's topic — each in its own `try` (I-1): one family's failure never blocks the others.

## Two database connections (W2-3, audit S-2)

`local-runner.ts` opens two Prisma clients, neither the owner role:

- **`PUBLISHER_DATABASE_URL`** (role `budget_publisher`, ADR-010): claims, marks and dead-letters
  outbox rows, and runs every workspace/org discovery query (`localActiveOrgs`, `localAllOrgs`,
  `localOrgsPendingPurge`, `localWorkspacesForReindex` in `packages/db/src/runner.ts`). This role
  holds only the column-level grants those queries need (migrations `20260924070000`,
  `20261010000000`, `20261010040000`) and is `NOBYPASSRLS` like every other login role — it cannot
  read `envelope`, `spend_fact` or any other tenant table.
- **`APP_DATABASE_URL`** (role `budget_app`): runs the real consumer handlers inside `withTenant()`,
  the same connection and the same tenant isolation the API uses.

The service used to run its poll loop on `DATABASE_URL` (the owner role, which `bootstrap.ts` once
gave a standing `BYPASSRLS`): a worker that processes attacker-influenced input (uploaded CSVs,
warehouse rows, Slack payloads) on a role that bypasses every RLS policy was flagged as audit S-2.
`PUBLISHER_DATABASE_URL` is a required secret — the service fails at startup if it is unset, rather
than silently falling back to the owner.

## How a row is published or retried

- **All applicable families succeed:** `published_at = now()`.
- **At least one fails:** the row is **not** published. `attempts` increments, `last_error` holds
  the first failure's message (truncated to 2000 chars), and `next_attempt_at` backs off
  exponentially: `30s * 2^min(attempts, 6)`, so roughly 30s, 60s, 120s, 240s, 480s, 960s, then
  capped at ~32 minutes. Once `attempts` reaches `OUTBOX_MAX_ATTEMPTS` (default 8), `failed_at` is
  set and the row is **dead-lettered**: `claimLocalOutbox` (`packages/db/src/outbox.ts`) excludes
  any row with `failed_at IS NOT NULL` outright, backoff or not.
- **A family that already succeeded is not re-run** on a later attempt of the same row: each family
  dedupes on `(consumer, outbox_id)` in `processed_event` (`consumer.ts`'s `handleOnce`), and the
  outbox id never changes across retries of the same row — only the families that failed actually
  do work again.

| Attempt | Backs off until (from this failure) |
|---|---|
| 1 | +30s |
| 2 | +60s |
| 3 | +120s |
| 4 | +240s |
| 5 | +480s |
| 6 | +960s |
| 7, 8 | +960s (capped) — attempt 8 also sets `failed_at` |

## Listing dead-lettered rows

```sql
SELECT id, topic, workspace_id, attempts, last_error, failed_at
  FROM outbox
 WHERE failed_at IS NOT NULL
 ORDER BY failed_at DESC;
```

Run as the **publisher role** (`PUBLISHER_DATABASE_URL`), not the owner: `budget_publisher` holds
full `SELECT` on `outbox` plus `UPDATE` on exactly the retry columns below, which is also everything
this and the next section need. The owner role (`DATABASE_URL`) no longer bypasses RLS (W2-3, audit
S-2, S-3, S-21) and cannot see `outbox` rows at all outside the one migration/bootstrap job.

## Replaying a dead-lettered row

Clear its retry state so the next poll claims it again:

```sql
UPDATE outbox
   SET failed_at = NULL, attempts = 0, next_attempt_at = NULL
 WHERE id = …;
```

Check `last_error` first — a row that fails the same way every time (a malformed payload, a
deleted envelope its payload still names) will fail again immediately; fix the underlying data or
code before replaying, or it burns another 8 attempts for nothing.

## Timeouts (I-7)

`handleOnce` (`apps/workers/src/consumer.ts`) takes an optional `timeoutMs`, passed through to
`withTenant()`. Most consumers keep the 15s default. The roll-up and search-indexer handlers pass
300s (`ROLLUP_TIMEOUT` in `rollup.ts`, `SEARCH_TIMEOUT` in `search-indexer/indexer.ts`): a
`registry.changed` or `budget.changed` (kind `granularities`/`moved`) rebuilds every hierarchy
template for every cached period in one transaction, and a `naming.changed` (kind `display`)
re-indexes every envelope — both can run long on a workspace with real history, and the old 15s cap
would abort the transaction (previously indistinguishable from any other failure, and — before this
runbook's retry columns existed — silently marked published anyway, I-1).

## Payload validation (I-29)

The roll-up, search-indexer, notify-in-app and notify-Slack handlers parse their event's payload
against a per-topic zod schema (`packages/domain/src/outbox-payloads.ts`,
`parseOutboxPayload(topic, payload)`) before reading any field from it. Every schema is
`.passthrough()` and every field optional — the goal is to fail loudly on a payload that doesn't
look like JSON for its topic, not to reject anything a correct writer might send. A parse failure is
an ordinary handler failure: it counts toward `attempts` like any other, logged as that family's
consumer failing.

## Exports (I-2)

`export.requested` is subscribed (`topicsFor("export")`, `@budget/domain`) alongside ingest,
roll-up and notify; `handleExportRequested` (`apps/workers/src/export/export.ts`) runs with the same
`ObjectStore` the standalone `export-worker` entrypoint would use (`objectStoreFromEnv()` —
`GcsObjectStore` when `UPLOAD_BUCKET`/`GOOGLE_CLOUD_PROJECT` or `GCS_EMULATOR_HOST` is set, else an
in-memory store). Before W1-2, `POST /api/v1/exports` queued jobs that stayed `queued` forever in
every deployed environment; they now complete in the same pass as any other outbox row.

## Graceful shutdown (M-7)

On `SIGTERM` or `SIGINT`, the loop sets an internal "stopping" flag (`shutdown()` in
`local-runner.ts`) and logs that it is draining. It finishes the row it is currently running, then
stops claiming more — it does not interrupt a row partway through. The health server
(`GET /` on `PORT`, default 4799) keeps answering `200` for the whole drain, so Cloud Run's health
check does not also think the instance is unhealthy while it is simply finishing up. Once the loop
exits, it closes the HTTP server and disconnects both Prisma clients, and the process ends.

## Other periodic passes

The same loop also runs, on their own schedules, independent of outbox rows: workspace purge (every
minute, ADR-052), fact/raw-file retention (daily, `FACT_RETENTION_ENABLED`, see
`docs/runbooks/retention.md`), snapshot integrity (weekly, `SNAPSHOT_INTEGRITY=off` disables),
search re-index (workspaces with an empty index on startup, every workspace daily, see
`docs/runbooks/search.md`) and pacing (`PACING_EVERY_MS`, see `docs/runbooks/pacing.md`). None of
these touch the outbox retry columns above; they have no row to fail or dead-letter — a failure
there is caught and logged, and the pass is simply tried again on its own next scheduled tick.
