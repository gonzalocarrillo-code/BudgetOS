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
- **The close is one transaction:**
  1. resolve the period;
  2. refuse a period that hasn't ended or is already closed;
  3. create the `period_closure` row (registry snapshot: dimension and template versions);
  4. lock the envelopes;
  5. compute the rows;
  6. store `variance_summary`;
  7. audit `closure.created`, outbox `period.closed`, bump the data version;
  8. write to the sink **last**, so a sink failure rolls everything back.
  - If the sink succeeds and the commit then fails, an orphan table is left. The next attempt gets CONFLICT and an operator drops it (runbook).
  - A partial unique index allows at most one `closed` closure per period.
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
- **Table versions:** `budget_vs_actual_<workspace>_<period>`; the N-th re-close of a period after restatements writes `_r<N>`. Restating never touches a table.
- **Ingestion:** facts dated in a `closed` period are rejected per row with a reason, unless the run was queued with `POST /sources/:id/run { restatementOf: <closureId> }`. The flag is kept in `ingest_run.summary`. After a restatement, the period accepts facts again.
- **Report:** `GET /closures/:id/report` returns the stored `variance_summary` and registry snapshot, frozen at close. The summary holds the totals and variance, the months' actuals, and each template's top-level nodes.

## Consequences

- Blocked, GCP: writing and querying a real closure table (streaming insert right after `createTable` can briefly hit BigQuery's eventual consistency; the proof will show whether a retry is needed), and the load-job path.
- The search indexer re-indexes a closure's envelopes on `period.closed` / `period.restated`, so status filters stay right. The rollup cache's `pendingCount` isn't refreshed by a close; spec §19 doesn't subscribe rollup-worker to period topics.
- Monthly budget in the closure table waits for a phased planner grain.
