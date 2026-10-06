# ADR-018: Closures, the ClosureSink and what a restatement restores

## Status

Accepted.

## Context

T-024 (spec §15, plan §4.5) adds period closures. The local done-when: a locked envelope rejects a draft with 423. Closing writes BigQuery `closures.budget_vs_actual_<workspace>_<period>` inside the close command, but the spec defines no sink interface (LOCAL_BUILD_PHASES finding 10). It also leaves open:
- how periods come to exist (`fiscal_period` has no routes);
- what "unlocks" restores the status to;
- how `grain='month'` is computed, when the planner only has `total`.

## Decision

- **`ClosureSink`** (`apps/api/src/modules/closures/sink.ts`), `write(table, rows)`:
  - The production class is **`BigQueryClosureSink`**. It creates the table with a fixed schema (money as BIGNUMERIC, dates, counts), then:
    - streams rows in 500-row chunks, each with an `insertId`, for BigQuery's best-effort dedupe;
    - or runs one NDJSON load job (`WRITE_EMPTY`) above 100k rows.
  - **A table is never written twice.** If it exists, the sink returns CONFLICT.
  - **`RecordingClosureSink`** keeps rows in memory for tests and for the golden seed, which has no BigQuery. It isn't a second system of record.
  - `closureSinkFromEnv` picks BigQuery with `GOOGLE_CLOUD_PROJECT` (dataset `CLOSURE_DATASET`, default `closures`), the recording sink only under `NODE_ENV=test`, and otherwise none, in which case `POST /closures` returns 503.
- **The close is one transaction** (superseded 2026-10-05: two transactions, see the addendum):
  1. resolve the period;
  2. refuse a period that hasn't ended or is already closed;
  3. create the `period_closure` row (registry snapshot: dimension and template versions);
  4. lock the envelopes;
  5. compute the rows;
  6. store `variance_summary`;
  7. audit `closure.created`, outbox `period.closed`, bump the data version;
  8. write to the sink **last**, so a sink failure rolls everything back.
  - If the sink succeeds and the commit then fails, an orphan table is left. The next attempt gets CONFLICT and an operator drops it (runbook).
  - A partial unique index allows at most one `closed` closure per period (`closing` or `closed` since the addendum).
- **Periods:** the body is `{ periodId }` (spec) or `{ periodKey }` (`FY2026`, `2026-Q1`, `2026-03`). A key is resolved with `resolvePeriod` and its `fiscal_period` row is created on first use. No fiscal-period API is added.
- **Locking:**
  - Every non-archived envelope overlapping the period becomes `LOCKED`, pending ones included. Versions are untouched.
  - `closure_envelope(closure_id, envelope_id, prior_status)` records the status it had.
  - An envelope covered by two closed closures (a month inside a closed quarter) keeps the status recorded by the first.
  - Restating (`closure.restate`, admin, reason required and stored on the audit row) sets `restated` and restores the prior status of the envelopes **no other closed closure covers**.
  - Writes already refuse LOCKED with 423 (T-010). Approval decisions and withdrawals on a request whose envelopes are locked are now 423 too.
- **Rows:** for every hierarchy template, every node (root and every depth) comes from `templateNodes`, the rollup worker's planner calls over live leaves (ADR-016).
  - `grain='total'` rows cover the whole period with every measure.
  - `grain='month'` rows run the same per calendar month with **actual and projected only**. The planner's budget is the envelope's whole amount (it has no phased grain), so a monthly budget would be wrong. Phased monthly budget comes when the planner gets `grain=month`.
- **Table versions** (superseded 2026-10-05: one table per closure id, see the addendum): `budget_vs_actual_<workspace>_<period>`; the N-th re-close of a period after restatements writes `_r<N>`. Restating never touches a table.
- **Ingestion:** facts dated in a `closed` period are rejected per row with a reason, unless the run was queued with `POST /sources/:id/run { restatementOf: <closureId> }`. The flag is kept in `ingest_run.summary`. After a restatement, the period accepts facts again.
- **Report:** `GET /closures/:id/report` returns the stored `variance_summary` and registry snapshot, frozen at close. The summary holds the totals and variance, the months' actuals, and each template's top-level nodes.

## Consequences

- Blocked, GCP: writing and querying a real closure table (streaming insert right after `createTable` can briefly hit BigQuery's eventual consistency; the proof will show whether a retry is needed), and the load-job path.
- The search indexer re-indexes a closure's envelopes on `period.closed` / `period.restated`, so status filters stay right. The rollup cache's `pendingCount` isn't refreshed by a close; spec §19 doesn't subscribe rollup-worker to period topics.
- Monthly budget in the closure table waits for a phased planner grain.

## Addendum 2026-10-05: two-phase close (W3-1, audit I-4)

The single transaction above held every period envelope and the workspace row (`bumpDataVersion`) while `sink.write` did BigQuery I/O, under a 300 s timeout, so every other write in the workspace waited for BigQuery. A table named by the count of earlier closures also meant a failed attempt that had already created its table blocked every later close of the period with CONFLICT until someone dropped the table by hand.

The close is now two short transactions with the sink between them (`apps/api/src/modules/closures/commands/close-period.ts`):

1. **Start** (one transaction): resolve and validate the period; create the `period_closure` row as **`closing`**; lock the envelopes (`closure_envelope.prior_status` as before); compute the rows and store `variance_summary`; audit `closure.started`, outbox `period.closing`; bump the data version as the last statement; commit.
2. **Write**, outside any transaction: `sink.write(table, rows, { replace: true })`.
3. **Finish** (one transaction, closure row locked):
   - success: `closed`, `closed_at = now()`, audit `closure.created`, outbox `period.closed` (names unchanged, so the roll-up and search handlers keep working);
   - sink failure: **`failed`** with `period_closure.error`; the envelope locks are released the way a restatement releases them (prior status, unless another closing or closed closure covers the envelope); audit `closure.failed`, outbox `period.closure_failed`, bump. The caller gets the sink's DomainError, or 503 `UNAVAILABLE` (409 for BigQuery's own 409), never a bare 500.

Rules that follow:

- **Table name:** `closures.closure_<closure id without dashes>`. Every attempt has its own table, so a failed attempt's leftover never blocks the next one. Closures from before this addendum keep their `budget_vs_actual_<workspace>_<period>[_r<N>]` names; `bq_table` records each one. The sink still refuses to overwrite a table, except with `replace`, which only the close passes for its own closing closure's table (a retry after a partial write).
- **`closing` counts as closed** for ingestion and manual entry (`closedPeriods`: the envelopes are locked and the facts are being frozen) and for envelope locks (`lockPeriodEnvelopes`, `unlockClosureEnvelopes`). It is **not closed** for restatement: restating a `closing` closure is 409 ("in progress"), and a `failed` one is 409 too (it locks nothing).
- **One close at a time:** the partial unique index `period_closure_one_closed` covers `status IN ('closing', 'closed')` (migration `20261010030000_closure_two_phase`). A concurrent close of the same period waits on the index and gets 409.
- **Stale closes:** if the process dies between the steps, the closure stays `closing` with its envelopes locked. After 15 minutes (`CLOSURE_STALE_MINUTES`) `POST /closures/:id/abandon` (`closure.close`) moves it to `failed`, releases the locks, audits `closure.abandoned` and writes `period.closure_failed`. If the original request finishes writing afterwards, it finds the closure failed and returns 409; its table is then an orphan named by a failed closure's id, harmless and safe to drop. There is no automatic sweeper yet.
- `period.closing` and `period.closure_failed` are consumed by the roll-up worker (pending counts) and the search indexer (envelope status), like `period.closed` and `period.restated`.
