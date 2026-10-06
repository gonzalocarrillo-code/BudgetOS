# Closures (T-024, ADR-018)

## Close a period

`POST /api/v1/workspaces/<ws>/closures {"periodKey": "2026-Q1"}` (FINANCE, WORKSPACE_ADMIN, ORG_ADMIN).
- It locks every live envelope overlapping the period, commits the closure as `closing`, writes `closures.closure_<closure id without dashes>` in BigQuery, then marks it `closed` (ADR-018 addendum, W3-1). Closures from before 2026-10-05 name `closures.budget_vs_actual_<ws>_<period>[_r<N>]`; `period_closure.bq_table` has each one.
- 409 means the period hasn't ended, is already closed, or is being closed right now.
- 503 means there's no closure sink (`GOOGLE_CLOUD_PROJECT` isn't set), or the BigQuery write failed. In the second case the closure is `failed` with the error and its envelopes are unlocked again: see below.

## Restate

`POST /api/v1/closures/<id>/restate {"reason": "…"}` (WORKSPACE_ADMIN, ORG_ADMIN).
- Envelopes get their prior status back, unless another closed closure (a month inside a closed quarter) still covers them.
- The old table stays; the next close of the period writes a new table named by its own closure id.
- A `closing` closure can't be restated (409, "in progress"); a `failed` one has nothing to restate.

## Load facts into a closed period without restating

`POST /api/v1/sources/<id>/run {"restatementOf": "<closureId>"}`. Without the flag, rows dated in a closed period are rejected with `period <key> is closed` in the rejected-rows report.

## Failed and closing closures: retry or abandon

List the attempts that didn't finish:

```sql
SELECT pc.id, fp.key, pc.status, pc.closed_at, pc.bq_table, pc.error
FROM period_closure pc JOIN fiscal_period fp ON fp.id = pc.period_id
WHERE pc.workspace_id = '<ws>' AND pc.status IN ('closing', 'failed')
ORDER BY pc.closed_at DESC;
```

- **`failed`**: the BigQuery write failed (`error` says why) and the envelopes are already unlocked. Fix the cause (quota, permissions, dataset) and close the period again: the retry writes a new table named by its own closure id, so nothing has to be dropped first. The failed attempt's table, if it was created, is partial; `bq rm -t closures.<bq_table>` is safe once you've checked that its closure is `failed`.
- **`closing` for more than a few minutes**: the API process died between writing BigQuery and marking the closure, and the period's envelopes are still locked. After 15 minutes from `closed_at`, abandon it from the Closures page, or `POST /api/v1/closures/<id>/abandon` (FINANCE, WORKSPACE_ADMIN, ORG_ADMIN). It becomes `failed`, the envelopes get their prior status back, and you can close the period again. Before 15 minutes, abandon returns 409: the close may still be writing.
- Never drop a table whose closure is `closed` or `restated`.

## A closure's envelopes stay LOCKED after a restatement

Find the other closing or closed closure that still covers them:

```sql
SELECT pc.id, fp.key
FROM closure_envelope ce
JOIN period_closure pc ON pc.id = ce.closure_id
JOIN fiscal_period fp ON fp.id = pc.period_id
WHERE ce.envelope_id = '<envelope>' AND pc.status IN ('closing', 'closed');
```

Restate that one too (or abandon it, if it is a stale `closing` one).
