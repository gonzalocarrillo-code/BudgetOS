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
