# ADR-011: Ingestion pipeline, object store and GCS emulator

## Status

Accepted.

## Context

T-017 (spec §14) needs several things with no local equivalent:

- Connectors that read Snowflake, Sheets, BigQuery and CSV.
- A pipeline that normalizes, validates, upserts and matches facts.
- Rejected rows written as CSV to GCS.
- Local proof, per LOCAL_BUILD_PHASES phase 12: the CSV connector against golden files, at least 99% matched, with the rejected-rows report written through a GCS emulator. The ADR names the emulator image before `docker-compose.yml` changes.

The live warehouses have no credentials in the spec (plan §16.4), so their `read()` implementations are built to the spec but not called in the gate.

## Decision

- **Emulator: `fsouza/fake-gcs-server:1.52.2`** (BSD-2-Clause), with an in-memory backend over plain HTTP on 127.0.0.1:4443.
  - Added to `docker-compose.yml` as service `gcs`.
  - On a machine where 4443 is taken:

    ```bash
    docker run -d --name budget-os-gcs -p 127.0.0.1:4443:4443 fsouza/fake-gcs-server:1.52.2 -scheme http -port 4443 -public-host 127.0.0.1:4443 -backend memory
    ```
  - `GcsObjectStore` talks to it when `GCS_EMULATOR_HOST=http://127.0.0.1:4443` is set, by passing that host to `@google-cloud/storage` as `apiEndpoint`.
  - The library's own `STORAGE_EMULATOR_HOST` is not used: with it set, bucket calls lose the `/storage/v1` prefix and the emulator answers 404.
  - The ingest test that proves the rejected-rows report runs only when `GCS_EMULATOR_HOST` is set, like the Redis test in ADR-008.
- **`ObjectStore`** (`apps/workers/src/ingest/object-store.ts`) has two implementations:
  - `GcsObjectStore` uses `@google-cloud/storage`. It works against the emulator locally and against real GCS in deployed environments.
  - `MemoryObjectStore` is for the golden seed and unit tests, so `pnpm db:seed` needs no emulator.
- **Uploads stay inside the workspace.** A CSV source's URI must sit under `gs://<bucket>/uploads/<workspaceId>/`. A source can't point at another tenant's upload.
- **Runs are queued, not run in the request.**
  - `POST /sources/:id/run` creates an `ingest_run` with status `queued` and writes an outbox row with topic `ingest.requested`.
  - The ingest worker consumes that topic through `handleOnce` (ADR-010) and calls `runIngest`.
- **Partitions.** Fact tables are partitioned by month, and `budget_app` can't create tables.
  - `ensure_fact_partitions` becomes `SECURITY DEFINER` (owner) with a fixed `search_path`, and `budget_app` gets `EXECUTE` on it.
  - The pipeline calls it for the months a run loads. The pacing job (spec §11) already expected to call it.
- **Matching** is spec §14 step 5, the most specific envelope tuple that is a subset of the fact's tuple, applied to `spend_fact`, `kpi_fact` and `projection_fact` for the run.
  - The §24.3 order (external id, then match key, then tuple) and `match_method` are T-036.
- **Batching.** Facts are upserted in chunks of 5,000 with `INSERT … SELECT unnest(…) ON CONFLICT`.
  - The `COPY` path spec §14 asks for above 50k rows (`pg-copy-streams`) is left for the T-034 load job. Prisma owns the connection, and `COPY` would need a second client that sets the tenant GUCs itself.
- **`suggest-mapping`** calls `mapColumns()` in `@budget/ai` (OpenAI `openai` 7.23.0, JSON mode, zod-validated). Without `OPENAI_API_KEY` the route answers 503 `UNAVAILABLE`. The route is not stubbed.
- **Sheets** uses `@googleapis/sheets`, the Sheets-only client from the `googleapis` family, rather than the whole `googleapis` bundle.

## Consequences

- `docker compose up` now starts Postgres, Redis and the GCS emulator.
- The Snowflake, Sheets and BigQuery connectors are typechecked but not called until credentials exist. `suggest-mapping` is not exercised without an OpenAI key.
- A source whose FX rate is missing rejects those rows, with the reason in the report. The run does not fail.
- The pipeline loads `spend`, `kpi` and `projection` rows. Spec §14's `target` kind (target import from a Sheet or CSV) isn't built, so `POST /workspaces/:ws/targets/import` stays open (ADR-009).
- KPI facts hash the row plus `:<metric>`. One row with several KPI columns gives several `kpi_fact` rows, and the unique key `(workspace_id, source_row_hash, period_date)` needs a hash per fact.
- `POST /unmatched-spend/map` takes an existing `envelopeId`. Spec §14's `createEnvelope` and `addExternalId` variants are left for the Sources UI (T-032) and naming templates (T-036). A client can create the envelope first.
- A worker that dies mid-run leaves the run `running`. The runbook (`docs/runbooks/ingest.md`) says how to re-queue it.
