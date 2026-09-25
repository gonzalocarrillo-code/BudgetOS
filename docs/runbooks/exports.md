# Exports (T-023, ADR-017)

## What runs

- `POST /api/v1/exports` queues an `export_job` and an `export.requested` outbox row.
- `export-worker` (`apps/workers/src/export/main.ts`, Cloud Run push subscriber) builds the CSV/XLSX and writes it to `gs://$UPLOAD_BUCKET/exports/<workspace>/<job>.<csv|xlsx>`.
- `GET /api/v1/exports/:jobId` returns the job and a 15-minute download URL once `status = done`.

Locally, objects go to the GCS emulator when `GCS_EMULATOR_HOST` is set, and to memory otherwise.

## A job is stuck in `queued`

The outbox row wasn't delivered. Check that `outbox.published_at` is set for the `export.requested` row with `payload->>'jobId' = '<job>'`. If it's null, check `outbox-publisher`; if it's set, check the `export-worker` subscription and its dead-letter topic.

## A job is stuck in `running`

The worker died mid-export. Jobs aren't retried: the dedupe row is committed with the claim. Ask the requester to start a new export. If needed, mark the old job failed as the owner role:

```sql
UPDATE export_job SET status = 'failed', error = 'worker stopped; start a new export', completed_at = now() WHERE id = '<job>' AND status = 'running';
```

## A job `failed`

`export_job.error` holds the user-facing reason:
- the row cap: `EXPORT_MAX_ROWS` = 500,000;
- a metric removed from the library after queueing;
- an unexpected failure (details in the worker log under `requestId = export-worker-<job>`).

## Cleaning up

Export objects are deleted by the bucket's lifecycle rule (7 days, Terraform phase 20). `export_job` rows are never deleted.

## BigQuery curated views

- `infra/modules/bigquery/views/*.sql`, applied with the module.
- After a schema change that touches a column a view reads, run `pnpm --filter @budget/db test src/bigquery-views.test.ts`. It creates every view against the local Postgres schema.
