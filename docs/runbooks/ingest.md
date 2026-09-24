# Runbook: ingestion (T-017, ADR-011)

## Local setup

- `docker compose up -d` starts Postgres, Redis and the GCS emulator (`fsouza/fake-gcs-server:1.52.2` on 127.0.0.1:4443).
- Set `GCS_EMULATOR_HOST=http://127.0.0.1:4443`; `packages/db/.env.example` has it. Don't set the library's own `STORAGE_EMULATOR_HOST` (ADR-011).
- Without `GCS_EMULATOR_HOST` or `GOOGLE_CLOUD_PROJECT`, the API keeps uploads in memory. That's fine for one process, and it's what the golden seed uses.
- `pnpm db:seed` loads the golden actuals CSV through the pipeline. Check the run with `GET /api/v1/sources/:id/runs`: `summary.matchCoverage` should be `0.996916`.

## How a run moves

`POST /sources/:id/run` creates `ingest_run` with status `queued` and writes the outbox topic `ingest.requested`. The ingest worker, `handleIngestRequested` in `@budget/workers`, then does this:

1. It claims the run (`queued` → `running`) in the same transaction as its `processed_event` row, so a redelivered message does nothing.
2. It streams the source in 5,000-row batches.
3. It writes rejected rows to `gs://<UPLOAD_BUCKET>/reports/<workspaceId>/<runId>.csv`.
4. It matches facts to envelopes and finishes the run: `ok` with `summary`, plus one `ingest.run.finished` audit row and one `facts.loaded` outbox row.

A run that fails ends as `failed`, with `summary.error`, one `ingest.run.failed` audit row and one `ingest.failed` outbox row.

## Operations

- **A run stuck in `running`** means the worker died mid-run. Facts already upserted stay, and a re-run upserts the same rows (the row hash is stable). To recover:
  1. Set the run to `failed`: `UPDATE ingest_run SET status = 'failed', finished_at = now(), summary = '{"error":"worker lost"}' WHERE id = …`. This is the owner role, a manual operation.
  2. Call `POST /sources/:id/run` again.
- **Low match coverage:** use `GET /workspaces/:ws/unmatched-spend` for the tuples, then either create the missing envelope or call `POST /workspaces/:ws/unmatched-spend/map` with `{ dimensionValues, envelopeId }`.
- **Rejected rows:** open the report CSV. `_line` is the source line (the header is line 1) and `_reason` says why. `summary.rejectReasons` counts them by reason.
- **A missing FX rate** rejects that row; the run doesn't fail. Add the `fx_rate` row and re-run.
- **Snowflake, Sheets, BigQuery** need Secret Manager and credentials (phase 20). Until then, a source with a `secretRef` fails its run with "no Secret Manager client is configured".
- **`suggest-mapping`** needs `OPENAI_API_KEY`. Without it the route returns 503 `UNAVAILABLE`.
