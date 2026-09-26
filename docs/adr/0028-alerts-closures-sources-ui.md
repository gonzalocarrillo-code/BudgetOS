# ADR-028: Alerts, rule editor, closures, sources and the mapping wizard; a local ingest runner

## Status

Accepted.

## Context

T-032 (spec §18.5) builds five screens on APIs that exist since T-017, T-018 and T-024: the Alerts UI and rule editor, the Closures UI, and the Sources UI with the mapping wizard. The done-when is each screen's acceptance test.

Locally, three things were missing:
- Nothing ran a queued ingest run (Pub/Sub and the Cloud Run workers are cloud).
- Closing needed BigQuery (ADR-018: 503 without it).
- The wizard needs a mapping suggestion before any source exists (`POST /sources/:id/suggest-mapping` needs a source, and creating one needs a mapping).

## Decision

- **Alerts** (`/alerts`):
  - status tabs (Open / Acknowledged / Snoozed / Resolved) and severity chips, all in the URL;
  - each row shows the budget by name (a link), the rule, the value against its threshold (ratios as percentages, pace as a number), and the evaluator's budget / actual / projected;
  - actions: acknowledge, snooze 7 days, resolve. Without `envelope.edit_draft` they are disabled with a reason.
  - `GET /alerts` now also returns `envelopeName`, `ruleName`, `metric` and `comparator`.
- **Rule editor** (`/admin/rules`):
  - the rule list with each one's condition in words;
  - the editor: metric, comparator, threshold, consecutive days, days-left limit, severity, the KPI for `kpi_vs_target_pct`, scope through the Explorer's `FilterBar` (the spec's RuleEditor), and delivery (in-app, Slack channel, emails);
  - a live one-line summary, and active on/off;
  - arguments the form does not edit (a `period`) are kept on save.
- **Closures** (`/closures`):
  - the list, and a report for the selected closure: frozen totals, variance and the first template's top level;
  - "Close a period" takes a key (FY2026, 2026-Q3, 2026-08) and asks for confirmation, because closing locks every live budget in it;
  - "Restate" needs a reason and `closure.restate`; the buttons say who may.
  - **`CLOSURE_SINK=memory`** is an explicit opt-in for the local stacks (Playwright, `e2e:stack`): the recording sink keeps the frozen rows in that API process. Deployed environments still need BigQuery, and without either closing is still 503.
- **Sources** (`/sources`):
  - each source's runs (status, rows read / accepted / rejected, spend matched), refreshed every 2 s while a run is queued or running;
  - "Run now", disabled with a reason when paused or already busy;
  - unmatched spend, largest first, with "Assign to a budget" (envelope search → `POST /unmatched-spend/map`).
- **Mapping wizard** (`/admin/sources`):
  1. **File.** Pick a CSV; its header and first 20 rows are read in the browser (`parseCsvSample`).
  2. **Columns.**
     - Each column gets a role (date with its format, spend with inline currency, currency, KPI with its metric, projection, …) or a granularity (with a transform).
     - The first guess matches names against the registry and common names (`guessMapping`).
     - "Suggest with AI" posts the sample to the new **`POST /workspaces/:ws/mapping-suggestions`** (`source.manage`, `SuggestMappingSampleInput`, nothing saved), which calls `@budget/ai` `mapColumns()`. Without `OPENAI_API_KEY` it is 503, and the wizard says so and keeps the name matching.
     - The mapping is checked live with the domain's `SourceMapping` schema; its messages are what Next is disabled with.
  3. **Name and create.**
     - `POST /uploads` now also returns `method` (PUT for a signed GCS URL, POST for the emulator's media upload), the browser sends the file, the source is created, and its first run is queued.
     - Editing an existing source's mapping reuses step 2 (`PATCH /sources/:id`). Snowflake, Sheets and BigQuery sources are listed, but their credentials are Secret Manager (cloud).
- **Local ingest runner** (`apps/workers/src/local-runner.ts`), for the Playwright stack and `e2e:stack` only:
  - polls the outbox for `ingest.requested` rows of local workspaces (slug prefix `e2e-`, so never another test's rows);
  - hands each to the real push handler (`handleIngestRequested`) in-process, then marks that row published;
  - creates the uploads bucket in the GCS emulator.
  - It never publishes other topics or other workspaces' rows, so the outbox publisher tests are unaffected.

## Consequences

- Two response fields (`/alerts` names, `/uploads` method) and one route (permission-matrix row); OpenAPI and the web client regenerated.
- The local stacks have a fourth process (the runner, on 4799 + offset). A run started from the UI finishes locally; deployed environments are unchanged.
