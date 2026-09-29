# Replica and retention

docs/DATA_PLAN.md §1, D-001 to D-003. Postgres is the system of record. BigQuery holds a replica
written by Datastream only. Facts older than 13 months leave Postgres once the replica has them.

## Turning the replica on

1. `infra/modules/bigquery`: the dataset and curated views (`v_snapshots` included).
2. Cloud SQL: set `cloudsql.logical_decoding=on`, restart, then run `infra/modules/datastream/setup.sql`
   as a superuser. Put the `budget_datastream` password in Secret Manager.
3. `infra/modules/datastream`: the stream (backfills every table, then streams changes).
4. Wait for the backfill. Check a month: `SELECT count(*) FROM <dataset>.spend_fact WHERE workspace_id = '<ws>'`
   against the same count in Postgres.
5. API: set `BIGQUERY_PROJECT`, `BIGQUERY_DATASET`. Heavy grouped queries route there (ADR-042).

## Turning fact retention on

Workers: `FACT_RETENTION_ENABLED=true` and the same `BIGQUERY_DATASET`. Once a day, per workspace:

- Months before the cutoff (the first day of the month 12 months before this one) are checked
  oldest first. A month is deleted from `spend_fact`, `kpi_fact`, `projection_fact` and
  `spend_month` only when the replica has the same row count and total per table.
- The first month that does not match stops the run for that workspace; it is logged
  (`retention: replica does not match; month kept`) with both sides' totals. Nothing after it is
  touched, so Postgres always keeps one unbroken run of recent months.
- Each month deleted writes a `facts.pruned` audit event and outbox row, and moves the workspace's
  `settings.factsPrunedBefore` forward.

After that, a `/query` whose period starts before `factsPrunedBefore` runs on BigQuery when its
shape allows, and is refused (422) otherwise; exports and period closes over those months are
refused. Nothing silently reads a period with its spend missing.

## Raw uploads

The same pass deletes files under `gs://<UPLOAD_BUCKET>/uploads/<workspace>/` older than the
workspace's `settings.rawFileRetentionDays` (400 by default), except files a data source still
points at. Each run that deletes writes an `uploads.pruned` audit event and outbox row.

## Undoing

Nothing to undo in BigQuery: it keeps every month. To bring months back to Postgres, re-ingest them
from the source, then remove `factsPrunedBefore` from the workspace's settings.
