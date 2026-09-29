# datastream

Replicates the Budget OS Postgres database into the BigQuery dataset owned by `../bigquery`
(docs/DATA_PLAN.md §1, D-001). BigQuery is written by this stream only; the app never writes it.

## Order

1. Apply `../bigquery` (the dataset and curated views).
2. On Cloud SQL: set the `cloudsql.logical_decoding` flag, then run `setup.sql` as a superuser.
   It creates the publication, the replication slot and the read-only `budget_datastream` role.
   Store that role's password in Secret Manager.
3. Apply this module with the dataset id from step 1 and the secret from step 2.
4. Set `BIGQUERY_DATASET` on the API: heavy queries route to the replica (ADR-042).
5. Only then enable fact retention (`FACT_RETENTION_ENABLED=true` on the workers, D-002). It
   deletes nothing until BigQuery matches Postgres for a whole month.

## What does not replicate

`outbox`, `processed_event` and `_prisma_migrations` (transient or internal). Everything else,
including snapshots (`budget_baseline`, `budget_baseline_row`) and the audit log, replicates.
BigQuery has no row-level security: nothing outside the app reads this dataset except through
per-workspace authorized views (D-014).
