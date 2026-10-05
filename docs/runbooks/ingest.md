# Runbook: ingestion (T-017, ADR-011)

## Local setup

- `docker compose up -d` starts Postgres, Redis and the GCS emulator (`fsouza/fake-gcs-server:1.52.2` on 127.0.0.1:4443).
- Set `GCS_EMULATOR_HOST=http://127.0.0.1:4443`; `packages/db/.env.example` has it. Don't set the library's own `STORAGE_EMULATOR_HOST` (ADR-011).
- Without `GCS_EMULATOR_HOST` or `GOOGLE_CLOUD_PROJECT`, the API keeps uploads in memory. That's fine for one process, and it's what the golden seed uses.
- `pnpm db:seed` loads the golden actuals CSV through the pipeline. Check the run with `GET /api/v1/sources/:id/runs`: `summary.matchCoverage` should be `0.996951`.

## How a run moves

`POST /sources/:id/run` creates `ingest_run` with status `queued` and writes the outbox topic `ingest.requested`. The ingest worker, `handleIngestRequested` in `@budget/workers`, then does this:

1. It claims the run (`queued` → `running`) in the same transaction as its `processed_event` row, so a redelivered message does nothing.
2. It streams the source in 5,000-row batches and upserts each fact on its natural key (ADR-071): the source's `row_id`, or its business key (date, tuple, match key, metric). The amount is not part of the key, so a restated row updates its fact.
3. It writes rejected rows to `gs://<UPLOAD_BUCKET>/reports/<workspaceId>/<runId>.csv`.
4. In a **full** run (`summary.mode = "full"`), it supersedes the source's facts dated inside `summary.coveredRange` that the run did not deliver. Closed periods are skipped unless the run restates them. Superseded facts stay in the table (`superseded_at`, `superseded_by_run_id`), but nothing counts them.
5. It matches facts to envelopes and finishes the run: `ok` with `summary` (including `mode`, `superseded` and `coveredRange`), plus one `ingest.run.finished` audit row and one `facts.loaded` outbox row.

Which runs are full and which are incremental:

- CSV, Sheets and BigQuery without `updatedAtColumn`: every run is full.
- Snowflake, and BigQuery with `updatedAtColumn`: incremental. Each run reads rows updated since the previous run started, minus one hour. These sources must map a **Row ID** column (`row_id`). Without one, the source can't be saved, and an older source fails its run with a message that says what to map.
- An incremental source's first run, and its first run after ADR-071, are full. So is a **Full resync**: the button on the Sources page, or `POST /sources/:id/run` with `{ "fullResync": true }`.

A run that fails ends as `failed`, with `summary.error`, one `ingest.run.failed` audit row and one `ingest.failed` outbox row.

## Operations

- **Re-running a source reconciles it (ADR-071).** Rows that are unchanged update their own facts. Restated amounts replace the old ones. In a full run, rows the source no longer has are superseded within the dates the run covers, and the Sources page shows "N facts superseded". A row that comes back in a later run is live again.
  - Be careful with a rerun that rejects rows it used to accept (a missing FX rate, a retired value, a mapping change): those rows' facts are superseded too. Fix the cause and run again.
- **Deleted upstream, still counted:** for an incremental source, use **Full resync**. An incremental run can't see deletes.
- **What a run superseded:** `SELECT period_date, amount, envelope_id FROM spend_fact WHERE superseded_by_run_id = '<runId>'` as the owner role. Nothing is deleted, and a later run that delivers the rows again restores them.
- **A run stuck in `running`** means the worker died mid-run. Facts already upserted stay, and a re-run upserts the same facts on their natural keys and reconciles the rest. To recover:
  1. Set the run to `failed`: `UPDATE ingest_run SET status = 'failed', finished_at = now(), summary = '{"error":"worker lost"}' WHERE id = …`. This is the owner role, a manual operation.
  2. Call `POST /sources/:id/run` again.
- **Low match coverage:** use `GET /workspaces/:ws/unmatched-spend` for the tuples, then either create the missing envelope or call `POST /workspaces/:ws/unmatched-spend/map` with `{ dimensionValues, envelopeId }`.
- **Rejected rows:** open the report CSV. `_line` is the source line (the header is line 1) and `_reason` says why. `summary.rejectReasons` counts them by reason.
- **A missing FX rate** rejects that row; the run doesn't fail. Add the `fx_rate` row and re-run.
- **Snowflake, Sheets, BigQuery** need Secret Manager and credentials (phase 20). Until then, a source with a `secretRef` fails its run with "no Secret Manager client is configured".
- **`suggest-mapping`** needs `OPENAI_API_KEY`. Without it the route returns 503 `UNAVAILABLE`.

## How fresh the actuals are (HO-003, ADR-062)

Home and the Overview show "Actuals through <date>" and count time gone, and so pace, through that
day rather than today (`dataAsOf()` in `packages/db/src/data-as-of.ts`).

- **Through:** the last spend fact's date, extended to the end of its month when the source's
  `period_date` column is monthly (`format: "yyyy-MM"` in the mapping). It is never later than today.
- **Stale:** a daily source more than **2 days** behind today (`STALE_AFTER_DAYS`), or a monthly source
  still missing a whole month **10 days** after that month ended (`MONTHLY_GRACE_DAYS`): August's
  file may arrive until 10 September. Both screens then show a
  banner with the date and a link to Spend data. Nothing else changes: pace is already read as of that day.
- **A banner that should not be there:** check the source's latest run (`GET /api/v1/sources/:id/runs`)
  and its mapping's `period_date` format. A monthly file mapped as daily reads as stale after two days.
- **Changing the thresholds** is a code change to those two constants, with a note in ADR-062; the
  `data-as-of.test.ts` cases pin both.
