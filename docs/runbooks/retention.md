# Replica and retention

docs/DATA_PLAN.md §1, D-001 to D-003. Postgres is the system of record. BigQuery holds a replica
written by Datastream only. Facts older than 13 months leave Postgres once the replica has them.

## Turning the replica on

1. `infra/modules/bigquery`: the dataset and curated views (`v_snapshots` included).
2. Cloud SQL: set `cloudsql.logical_decoding=on`, restart, then run `infra/modules/datastream/setup.sql`
   as a superuser. Put the `budget_datastream` password in Secret Manager.
3. `infra/modules/datastream`: the stream (backfills every table, then streams changes). The
   destination is append-only (ADR-054 addendum, audit I-8): a Postgres DELETE never removes a row
   from BigQuery, it lands as a new row with `datastream_metadata.change_type = 'DELETE'`. The
   curated views, and the retention job's own comparison, already collapse this to the latest
   non-deleted row per primary key — nothing extra to do when checking the replica by hand, except
   query a curated view (or add the same `QUALIFY` yourself) rather than a raw replicated table.
4. Wait for the backfill. Check a month: `SELECT count(*) FROM <dataset>.spend_fact WHERE workspace_id = '<ws>'`
   against the same count in Postgres — this raw count includes replayed rows, so prefer a curated
   view or the pattern in `infra/modules/bigquery/views/v_budget_current.sql` for a true count.
5. API: set `BIGQUERY_PROJECT`, `BIGQUERY_DATASET`. Heavy grouped queries route there (ADR-042).

## Turning fact retention on

Workers: `FACT_RETENTION_ENABLED=true` and the same `BIGQUERY_DATASET`. Once a day, per workspace:

- Months before the cutoff (the first day of the month 12 months before this one) are checked
  oldest first. A month is deleted from `spend_fact`, `kpi_fact`, `projection_fact` and
  `spend_month` only when the replica has the same row count and total per table.
- The first month that does not match stops the run for that workspace; it is logged
  (`retention: replica does not match; month kept`) with both sides' totals. Nothing after it is
  touched, so Postgres always keeps one unbroken run of recent months.
- The compare against the replica and the delete are separate transactions, so a restatement could
  land between them (audit I-13): the delete transaction re-counts the month and compares again
  before deleting anything. A mismatch there stops the run the same way, logged as `retention: facts
  changed between compare and delete; month kept, nothing deleted or audited` — no delete, no audit,
  no outbox for that month; the next run picks it up once things settle.
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
