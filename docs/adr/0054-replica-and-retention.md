# ADR-054: The BigQuery replica, and moving old facts out of Postgres

## Status

Accepted (product feedback round 8, docs/DATA_PLAN.md §1, tasks D-001 to D-003). Applying the Datastream stream waits for a GCP project; everything else runs locally.

## Context

The owner asked where history should live. The plan already said "Postgres for truth, BigQuery for history" and "hot 13 months in Postgres, everything in BigQuery", and the curated BigQuery views and the ADR-042 warehouse routing were built against a replica that did not exist yet. Nothing ever removed old facts from Postgres.

## Decision

- **One writer per store.** The app writes Postgres. Datastream writes BigQuery, from a publication over every table except `outbox`, `processed_event` and `_prisma_migrations`, with partitioned facts published under their parent. The replication role reads every table and writes none. `infra/modules/datastream` holds the stream; `setup.sql` holds the one-time Postgres side, which needs superuser rights the app never has.
- **Facts leave Postgres only when the replica has them.** A daily job, off unless `FACT_RETENTION_ENABLED=true` and a replica is configured, checks each workspace's months before the cutoff (13 months hot), oldest first. It deletes a month only when BigQuery has the same row count and total per fact table, and stops at the first month that differs. Postgres therefore always holds one unbroken run of recent months, and a replica that lags or drifts deletes nothing.
- **No silent gaps.** The workspace records `settings.factsPrunedBefore`. A `/query` over an earlier period runs on BigQuery when its shape allows, and is refused otherwise; exports and period closes over those months are refused. Budgets, versions, snapshots, approvals and audit are never pruned: only facts, which the client's warehouse holds anyway.
- **Raw uploads have a per-workspace retention** (`settings.rawFileRetentionDays`, 400 days by default). The job never deletes a file a data source still reads.
- **`v_snapshots`** joins each snapshot's header to its frozen rows in BigQuery, for plan-versus-close across years.
- Every deletion writes one audit event and one outbox row (`facts.pruned`, `uploads.pruned`).

## Consequences

- Until the stream runs, nothing changes: the job is off, and without a replica it can never delete facts.
- BigQuery has no row-level security. Nothing outside the app may read the replica except through per-workspace authorized views (D-014).
- Month totals are compared to the cent in reporting currency; a restated month that has not replicated yet simply stays in Postgres until it has.

## Addendum, 2026-10-06 (audit I-8, I-13)

The stack audit (`docs/STACK_AUDIT_2026-10-04.md`) found two problems with the design above, fixed in W3-7:

- **The stream must be append-only, not merge.** `bigquery_destination_config` defaults to merge mode,
  which applies source DELETEs to the BigQuery tables — including the retention job's own deletes. A
  month that just left Postgres because BigQuery held it would then be deleted from BigQuery too, and
  `factsPrunedBefore` would route reads over that month to a replica with no rows: a silent gap, the
  exact failure mode this ADR exists to prevent. `infra/modules/datastream/main.tf` now sets
  `append_only {}` on the destination. In this mode every Postgres change (insert, update, delete)
  lands as its own BigQuery row carrying `datastream_metadata.{uuid, source_timestamp, change_type}`;
  nothing is ever removed from BigQuery. The five curated views in `infra/modules/bigquery/views`
  collapse each raw replicated table to its latest row per primary key and drop rows whose latest
  change is a `DELETE` (`QUALIFY ROW_NUMBER() OVER (PARTITION BY <pk> ORDER BY
  datastream_metadata.source_timestamp DESC) = 1 AND datastream_metadata.change_type != 'DELETE'`),
  before any business logic runs; `packages/db/src/bigquery-views.test.ts` checks the pattern is
  applied to every raw table a view reads, and still runs each view against the real Postgres schema
  (the BigQuery-only clause is a documented no-op there — Postgres's live tables hold one row per key
  already). The retention job's own BigQuery comparison (`BigQueryReplicaTotals.monthTotals` in
  `apps/workers/src/retention/retention.ts`) applies the same pattern inline, so a replayed change is
  counted once, not once per change.
- **The compare and the delete must agree, not just both run.** Retention compared Postgres to the
  replica in one transaction and deleted by date range in a later one; a restatement landing between
  them was deleted unverified. `pruneWorkspaceFacts` now re-runs the Postgres count inside the delete
  transaction (`RepeatableRead`, so the recheck and the delete share one snapshot) and aborts the
  month — no delete, no audit, no outbox — if it no longer matches what was compared against the
  replica. `apps/workers/src/retention/retention.test.ts` exercises the race with an injected
  `beforeDelete` hook.

Nothing above changes the rest of the decision: the job is still off without `FACT_RETENTION_ENABLED`
and a replica; the comparison is still exact, table by table, oldest month first.
