# ADR-081: Idempotency-Key on every mutating route

## Status

Accepted (W3-2, audit I-6, spec §17).

## Context

Spec §17 says every mutating endpoint accepts `Idempotency-Key` ("stored in Redis 24h; replay returns
the original response"). None did (audit I-6): a retried or double-clicked POST created a second
envelope, thread, baseline, export job, manual-entry batch, experiment or saved view. Natural
idempotency (`basedOnVersionId`, `rowVersion`, submit/decide state checks, preview `take`) covers
draft edits, approvals and bulk commits, but not creates. There is no Redis in any deployed
environment (ADR-0072), and the API runs more than one instance, so the store must be Postgres.

Commands open their own `withTenant()` transaction(s); threading an outer transaction through ~120
handlers to make the key and the write commit together would touch every command.

## Decision

- **Table `idempotency_key`** (migration `20261013020000_idempotency_key`): `id`, one of
  `workspace_id` / `org_id` / `slack_team_id` (CHECK: exactly one), `actor_id`, `key`, `route`,
  `fingerprint` (sha256 of method, URL and body), `status`, `response json`, `created_at`,
  `completed_at`. Partial unique indexes on (workspace, actor, key), (org, actor, key) for
  org-level routes, and (Slack team, key). RLS enabled and forced: workspace rows by
  `app_visible_workspace_ids()`, org rows by `app_org_id()`, both limited to the acting person
  unless the session is a system one (no `app.user_id`) or org-wide admin; Slack rows only under
  `app.slack_team_id`. `budget_mcp` gets SELECT (ADR-019 guard). `response` is `json`, not `jsonb`,
  so a replay is byte-identical (jsonb reorders keys).
- **`withIdempotency` (`packages/db/src/idempotency.ts`)** runs claim → handler → store:
  1. *Claim*, in its own short tenant transaction: `INSERT … ON CONFLICT DO NOTHING RETURNING` is
     the lock. This key's own row past the 24 h TTL, or an in-flight claim older than the 10-minute
     lease (its request crashed), is deleted first.
  2. Lost the insert: the stored fingerprint differs → 422 `VALIDATION`; completed → replay the
     stored status and body; completed with no body (it was over 64 KB) → 409 `CONFLICT` "retry
     without the key"; still in flight → poll every 50 ms for up to 10 s, then 409.
  3. Won: the handler runs exactly as it does without a key. Success stores status and body
     (`completed_at`); any error deletes the row, so a failed attempt never burns the key. A
     response that is not JSON (the CSV export POSTs) is not stored: the key is released.
- **`IdempotencyInterceptor`** (global, after `TenantInterceptor` and `RateLimitInterceptor`) applies
  it to every POST/PUT/PATCH/DELETE that sends the header; without it nothing changes. A replay
  carries `Idempotent-Replayed: true`. Response headers the handler set (e.g. `x-data-version`) are
  not replayed.
- **Slack** (`slack.signed` routes) needs no header: the person is only known inside the handler,
  so the scope is the Slack team named in the signed body and the key is the request's
  `trigger_id` (Slack mints one per command, click and form submission; its retry carries the same
  one), or the signed timestamp and body when there is none. Slack's own retry
  (`X-Slack-Retry-Num`) therefore replays; a retry that finds the original still running is
  acknowledged with an empty 200 within 2.5 s. The plan said "retry number + trigger id"; the
  retry number is left out of the key because it differs between the original and its retry.
- **Web client** (`apps/web/src/lib/api.ts`): `idempotentFetch` puts a fresh UUID on every mutation
  and reuses it for its one retry after a network failure or 502/503/504.
- **TTL**: 24 h. The worker's daily `idempotencyPass` (`apps/workers/src/idempotency/sweep.ts`)
  deletes each org's expired rows in an org-wide app-role session; Slack rows are swept by their
  team's next claim. `idempotency_key` is in the workspace purge list.
- **OpenAPI**: the header is `components.parameters.IdempotencyKey`, referenced from every mutating
  operation by `withIdempotencyKey` in `openapi.ts`.

## Consequences

- **The gap.** The claim and the handler's write are separate transactions (the audit's preferred
  "same transaction" design would need every command to accept the caller's `tx`). If the process
  dies after the handler commits but before the response is stored, the row stays in flight; a
  retry waits and gets 409 until the 10-minute lease passes, then runs the handler again. Only the
  command's natural idempotency (`basedOnVersionId`, `rowVersion`, unique constraints — W3-3 adds
  more) protects that second run. Storing the response is also skipped (logged) if that last
  update fails; the client still gets the real answer.
- A keyed request costs two extra short transactions (claim, store); unkeyed requests cost nothing.
- Spec §17's "Redis" is superseded by Postgres, consistent with ADR-0072.
