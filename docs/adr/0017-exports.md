# ADR-017: Export jobs, file formats and the BigQuery curated views

## Status

Accepted.

## Context

T-023 (plan §6.2, spec §17 `exports`, §20) adds CSV and XLSX exports that respect the grid's filter, a Sheets push of a saved view, and the curated BigQuery views analysts and Looker read. The local done-when is that an export respects the filter. Sheets push and "views queryable" need GCP and stay blocked (LOCAL_BUILD_PHASES phase 13). The spec gives routes and the exceljs pin, not a job model.

## Decision

- **Every export is a job.** `POST /exports {kind, query, filename?}` (`export.run`) writes an `export_job` row, one `export.requested` audit_event and one `export.requested` outbox row. The request never builds the file, however small.
  - `export_job` is Prisma-owned, with workspace RLS and CHECKs on `kind` and `status`.
  - Status moves `queued → running → done | failed`.
- **The caller's scope is folded into the query when it is queued.** `readScopeFilter(assignments, "envelope.read")` (@budget/domain) turns the granting assignments' scopes into a FilterGroup with the same meaning as `canInScope`:
  - it is null when any granting assignment is unscoped, or for org admins;
  - otherwise it is the OR of the scopes, ANDed with the grid's filter.
  - A scope is a subset of the FilterGroup AST, so grouped exports are cut too; filtering rows afterwards could not do that.
  - The stored query is self-contained and the worker, a system actor, needs no identity. A role change after queueing doesn't change a queued job.
- **Fail early at the boundary.** The command compiles the query once, then throws the result away:
  - unknown metrics, bad `groupBy`, `grain`/`templateId` and other shapes the planner would refuse return 422 instead of a failed job;
  - `kind: "sheets"` returns 503 until the GCP clause.
- **export-worker.** `handleExportRequested` claims the job under `handleOnce`. The export itself runs afterwards:
  - it is one `RepeatableRead` transaction, so every page and the totals row see one snapshot;
  - the planner is paged 1,000 rows at a time, the cap is `EXPORT_MAX_ROWS` = 500k, and totals come from `compileTotals` (the worker never sums);
  - the file goes to `gs://<UPLOAD_BUCKET>/exports/<ws>/<job>.<ext>`;
  - completion writes the job, one `export.done` / `export.failed` audit_event and one `export.completed` outbox row (for a later "your export is ready" notification);
  - a job left `running` by a crash isn't retried, as with ingest (ADR-011).
- **Download.** `GET /exports/:jobId` returns the requester's job (an org admin sees any in the workspace; everyone else gets 404) and, once done, a 15-minute signed GET URL with `Content-Disposition: attachment`.
- **Columns** mirror the query:
  - flat rows: id, path, name, status, one column per dimension, the reporting currency, measures, then per target the KPI, target and vs-target;
  - grouped rows: code and label per `groupBy`, currency, measures, KPIs, leaf and pending counts;
  - a final `Total` row;
  - money as 2-dp text, ratios at 6 dp.
- **CSV:** RFC 4180 with a UTF-8 BOM. A text cell starting with `= + - @` or a tab/CR gets a leading `'`, so spreadsheets don't run it as a formula. Numbers are never escaped.
- **XLSX (exceljs 4.4.0, the spec §2 pin):**
  - frozen, bold, auto-filtered header; number formats per kind; bold totals; an `About` sheet with workspace, period, data version and the query;
  - numbers become doubles only in this writer, since that is the XLSX cell type. Values up to about 9e13 at 2 dp round-trip exactly.
- **Dependency hygiene for exceljs:**
  - A root `pnpm.overrides` pins `exceljs>unzipper` to 0.12.3. 0.10.x pulls `binary`, whose `buffers@0.1.1` has no licence at all. unzipper is used only for reading workbooks; we write them, and read them only in tests.
  - `pako@1.0.11` (MIT AND Zlib, via jszip) is a reviewed licence exception.
- **BigQuery views** (`infra/modules/bigquery`): the dataset `budget_os_<env>` plus `v_budget_current`, `v_budget_vs_actual_daily`, `v_approvals` and `v_closures`, as `google_bigquery_table` views from `views/*.sql`.
  - The SQL uses only what BigQuery and Postgres share. `packages/db/src/bigquery-views.test.ts` creates each view as a Postgres temp view over the real schema and checks `v_budget_current` on a fixture.
  - Views that read another view are a separate resource with `depends_on`.
  - The Datastream stream itself is phase 20.

## Consequences

- `GET /workspaces/:ws/query/export` (spec §17 `query`) arrives with the `/query` endpoint (T-027) as a thin alias of `POST /exports`.
- Blocked, GCP:
  - Sheets push (a `SheetsPusher` next to the existing Sheets connector);
  - running the views in BigQuery;
  - `terraform validate` (`terraform fmt` was not run locally, since neither terraform nor its image is installed).
- Export objects need a GCS lifecycle rule (delete after 7 days) when the bucket is created in Terraform (phase 20). Until then they stay in the bucket; `export_job` rows are kept.
