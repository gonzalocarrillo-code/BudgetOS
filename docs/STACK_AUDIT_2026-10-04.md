# Budget OS — stack audit (2026-10-04)

Audited: `main` at `9779c7d` (merge of PR #138), read-only, in a throwaway worktree. Scope as requested: **security**, **data truthfulness / integrity**, **maintainability**, plus **backups and data loss**. Five specialised review passes (auth, tenancy/SQL/input, aggregation truthfulness, write-path integrity with sub-passes for workers/concurrency/error-handling, maintainability+operations) were run; every finding marked **Verified** below was then re-read directly in the code by the author of this document. Findings marked **Reported** were confirmed by a review pass but not independently re-read. **Unverifiable** means the fact lives outside the repository (GCP console) and could not be checked because the local `gcloud` credentials have expired.

Severity: **Critical** = wrong money shown or data lost in production today; **High** = exploitable or lossy under realistic conditions; **Medium** = defect that will bite as usage grows; **Low** = hygiene.

---

## 0. Verdict in one page

**The core is strong.** Row-level security is enabled *and forced* on every tenant table, with policies that fail closed; every one of the 182 API routes declares a permission and the interceptor refuses undeclared ones; the IAP assertion and Google ID tokens are cryptographically verified (no header trust, no bypass flag anywhere); the query planner never interpolates user strings into SQL; money is `Decimal`/`NUMERIC(18,2)` end to end; derived KPIs are ratios of sums with null-safe division; totals are computed server-side over the same filtered set as rows; every API command writes its audit row and outbox row inside the same transaction; versions are append-only; the audit log is immutable by trigger; TypeScript discipline is exemplary (0 `any`, 0 `@ts-ignore`, 1 `eslint-disable` across ~89k lines).

**The risk is concentrated in four places**, all of them at the seams between the well-built core and the single-tenant production deployment that was stood up in a hurry (ADR-065):

| # | Finding | Severity | Why it is first |
|---|---|---|---|
| 1 | **Restated warehouse rows are added, not replaced** (fact hash covers the amount) | Critical | Every Snowflake/BigQuery correction inflates spend everywhere: Budgets, Home, Overview, Slack, MCP, pacing alerts |
| 2 | **Production worker acknowledges events whose handler failed** and never consumes `export.requested` | Critical | Silent loss of roll-ups, notifications, search updates; exports queue forever |
| 3 | **No test gate before deploy; Cloud SQL backups/PITR not in code or docs; no restore runbook** | Critical (ops) | A bad merge goes to production in one workflow run, and recovery is undefined |
| 4 | **Overview “assigned / unassigned” falls back to the over-pace subset** when the workspace lacks the default heatmap axes | High | Headline tile shows a number that is not what it says |

Then, in order: demo-data purge deletes real facts matched to demo envelopes (High); Redis absent in production while the app runs 3 instances, so bulk preview → commit can 404 (High); open redirect via backslash in `safeNext` (Medium, trivial fix); the deployed worker and a silent API fallback use the owner role with `BYPASSRLS` (Medium); `audit_event` insert policy is `WITH CHECK (true)` (Medium); the BigQuery connector interpolates an unvalidated `projectId` into SQL (High if the worker SA can read the replica).

Nothing found is a cross-tenant read through Postgres, a SQL injection, an auth bypass, or a fake/placeholder number in a production code path.

---

## 1. Security

### 1.1 Verified findings

**S-1 · High (impact Suspected) · BigQuery connector: `projectId` interpolated into SQL.**
`packages/domain/src/sources.ts:81` validates `projectId` only as `z.string().min(1)` while `dataset`/`table`/`updatedAtColumn` are regex-checked. `apps/workers/src/ingest/connectors/bigquery.ts:14-15` builds `` `${c.projectId}.${c.dataset}.${c.table}` `` into the query text. A workspace admin who can create a source can inject arbitrary SQL into the worker's BigQuery session, including `UNION ALL` reads of the shared replica dataset (which has no row-level security per ADR-054). Exploitability depends on the worker service account's BigQuery grants, which are not in the repo.
*Fix:* regex `^[a-z][a-z0-9-]{4,28}[a-z0-9]$` on `projectId`; give the ingest worker an SA with no access to the base replica dataset.

**S-2 · Medium · Deployed worker runs on the owner role, which bootstrap grants `BYPASSRLS`.**
`apps/workers/src/local-runner.ts:38` opens `PrismaClient` on `DATABASE_URL`; `.github/workflows/deploy.yml` mounts `DATABASE_URL=budgetos-database-url` on `budgetos-worker`; `apps/api/src/deploy/bootstrap.ts:21` runs `ALTER ROLE CURRENT_USER BYPASSRLS`. The worker processes attacker-influenced input (uploaded CSVs, warehouse rows, Slack payloads). AGENTS §4 forbids owner-role application code; ADR-010 created `budget_publisher` precisely for this loop.
*Fix:* outbox poll on `PUBLISHER_DATABASE_URL` (grants exist), workspace discovery through a minimal view; remove `DATABASE_URL` from the worker service.

**S-3 · Medium · API silently falls back to the owner connection.**
`apps/api/src/common/common.module.ts:18` — `process.env["APP_DATABASE_URL"] ?? process.env["DATABASE_URL"]`. If the app secret is missing or misnamed in a revision, the API boots as the owner with RLS off while appearing healthy.
*Fix:* read only `APP_DATABASE_URL`; add a boot check `SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user` that refuses to start when true.

**S-4 · Medium · `audit_event` INSERT policy is `WITH CHECK (true)`; `workspace_id` nullable.**
`packages/db/prisma/migrations/0002_platform/migration.sql:206`; never replaced by later migrations; `budget_mcp` holds `INSERT ON audit_event`. Any session, including the read-only MCP role, can write audit rows into another workspace's trail or with NULL workspace. The audit log is the evidence of record for approvals.
*Fix:* new migration: `WITH CHECK (workspace_id = ANY((SELECT app_visible_workspace_ids())::uuid[]))`, backfill and `NOT NULL`; extend `packages/db/src/rls.envelope.test.ts`.

**S-5 · Medium · Open redirect after login via backslash.**
`apps/api/src/common/auth/google-login.ts:56` — `safeNext` accepts `/\evil.example`; browsers treat `\` as `/` in special schemes, so the 302 `Location` resolves to `https://evil.example/`. A phishing link routes the victim through real Google sign-in and lands them on an attacker page imitating the "not added yet" screen. Test covers only `https://` and `//`.
*Fix:* `new URL(next, "https://x")` and require same origin; or allowlist SPA route prefixes; add `/\\evil` and `/%5Cevil` test cases.

**S-6 · Medium · No HTTP hardening on the app or MCP.**
No helmet/CSP/HSTS/X-Frame-Options anywhere in `apps/api/src`; no rate limiting on `/auth/*`, `/oauth/register`, `/oauth/token`, search, or the two OpenAI routes; CSRF relies solely on `SameSite=Lax`; `apps/api/src/configure-app.ts:11-16` registers the form-encoded parser **globally** (needed only for Slack), so every JSON write route also accepts a plain HTML form body; `GET /auth/logout` (`serve-web.ts:59`) is a state-changing GET.
*Fix:* `@fastify/helmet`; scope the form parser to `/slack/*`; `Origin`/`Sec-Fetch-Site` check on non-GET `/api/v1/*` in session mode; `POST` logout; `@fastify/rate-limit` keyed by IP on auth/oauth and by user on search/AI.

**S-7 · Medium · CSV formula injection in two of three CSV writers.**
`apps/workers/src/ingest/pipeline.ts:108-118` (rejected-rows report echoes raw source cells) and `apps/api/src/modules/envelopes/bulk/csv.ts:34-38` (used by CSV round-trip, baselines, budget import) only quote; `apps/workers/src/export/writers.ts:20,29` correctly neutralises `^[=+\-@\t\r]`. An editor can name an envelope `=HYPERLINK(...)`.
*Fix:* one shared `csvCell` in `@budget/domain`, used by all three.

**S-8 · Medium · Fastify 5.11.3 carries 4 high advisories** (`pnpm audit --prod`: 8 high / 7 moderate / 0 critical overall). Fastify → 5.12.5 (auth-bypass via malformed URL reaching encapsulated plugins is the relevant one, given the `onRequest` gates in `serve-web.ts`); lodash via Glide grid; toml via snowflake-sdk; js-yaml via nestjs/swagger. Dev tree adds vitest 2.1.9 (critical, UI server) and storybook/vite.
*Fix:* `pnpm.overrides` for fastify/lodash/toml/js-yaml; bump vitest/vite in the catalog; add `pnpm audit --prod --audit-level=high` to CI.

**S-9 · Low · Default role passwords committed in migrations** (`PASSWORD 'replace-in-secret-manager'` in `0001_roles`, publisher and MCP role migrations), rotated only when bootstrap runs with all three `*_DB_PASSWORD` secrets — and bootstrap throws *after* `migrate deploy`.
*Fix:* create roles `NOLOGIN`; bootstrap does `ALTER ROLE … LOGIN PASSWORD …`.

**S-10 · Low · Container runs as root with full source and devDependencies**, TypeScript compiled at start by `tsx` (`Dockerfile`). `.dockerignore` does exclude `.env*`, `.git`, `.claude`.

### 1.2 Reported findings (auth pass)

- **S-11 · Medium · Session cookie is a stateless 7-day JWT with no revocation**; logout only clears the browser cookie (`google-login.ts:18,95,99`). Deactivating the user does cut access. *Fix:* `jti` + session table/Redis; `__Host-` prefix; rotate on login; or 1 h TTL with silent refresh.
- **S-12 · Medium · MCP refresh tokens never rotate or revoke; authorization codes are replayable within 5 minutes** (`mcp-oauth.ts:95-116`); `/oauth/token` and `/oauth/register` unlimited. *Fix:* store refresh `jti`s, rotate and reject reuse, mark codes used, cap absolute lifetime.
- **S-13 · Medium (infra) · One runtime service account for app, Slack, worker, migrate and the public MCP** (`deploy.yml`). The public read-only MCP process can fetch the writable DB URL and the session signing key from the metadata server. *Fix:* one SA per Cloud Run service, each granted only its secrets.
- **S-14 · Low · Slack identity is the Slack profile email**; a Slack workspace admin can set a colleague's email on their own profile and act as them (audited under the victim's id). *Fix:* pin `slackUserId ↔ email` on first match; log the Slack user id in audit `after`.
- **S-15 · Low · Slack signature replay window of 300 s with no nonce cache**; `alert.snooze` and form submits are not idempotent.
- **S-16 · Low · Baselines write routes declare `workspace.member`** and rely on an in-service check, so the permission-matrix test cannot catch a regression.
- **S-17 · Low · MCP `export_csv` writes GCS objects** (one per call, 120/min) with no lifecycle rule on `exports/`.
- **S-18 · Low · Snowflake `account` unvalidated** (SSRF-shaped; mitigated because a secret is required).
- **S-19 · Low · LIKE/ILIKE wildcards unescaped** in planner and search (values are bound; `%`/`_` become wildcards → slow scans, email-prefix oracle bounded to the org).
- **S-20 · Low · Unknown `kid` in an IAP assertion triggers an upstream JWKS fetch per request**.
- **S-21 · Info · Owner's `BYPASSRLS` contradicts the SECURITY DEFINER premise** in `20260924030000_rls_identity_tables`; any future SECURITY DEFINER function is a full bypass.
- **S-22 · Info · Cross-org email enumeration via `POST /workspaces/:ws/members`** (single-org today).

### 1.3 Done well (security)
Fail-closed authorisation (undeclared permission → 403; 182/182 routes declared; matrix test fails on undeclared OpenAPI operations). Real crypto verification of IAP and Google tokens; OIDC with state+nonce+`email_verified`. RLS `ENABLE` + `FORCE` on every tenant table, policies with `USING` and `WITH CHECK`, helpers that return NULL/`{}`/false on empty settings. `withTenant` sets `set_config(..., true)` inside one transaction, so nothing leaks across the pool. Three least-privilege DB roles; MCP import-guard test; PKCE S256 mandatory. Planner whitelists every identifier and binds every value; `Prisma.raw` appears nowhere. Web has no `dangerouslySetInnerHTML`/`eval`; SVG uploads sanitised server-side. Secrets only via Secret Manager; nothing committed; workload-identity deploy scoped to `budgetos-*`.

---

## 2. Data truthfulness

### 2.1 Verified findings

**T-1 · Critical · Restated or re-delivered warehouse rows become additional facts.**
`apps/workers/src/ingest/normalize.ts:118-121` — `rowHash = sha256(sourceId + JSON.stringify(sorted row) + suffix)`; the hash covers **every** column including the amount and any `UPDATED_AT`/`loaded_at` column that `SELECT *` pulls. `packages/db/src/facts.ts:78-81` upserts `ON CONFLICT (workspace_id, source_row_hash, period_date) DO UPDATE SET amount = EXCLUDED.amount`, which can only fire for a byte-identical row, i.e. when nothing changed. Incremental connectors (`snowflake.ts:28`, `bigquery.ts:15`) re-deliver exactly the corrected rows. The `spend_month` trigger faithfully adds the duplicate; the planner's `actual` carries it everywhere.
*Wrong number:* a 1,000.00 row restated to 1,200.00 reads as **2,200.00 spent** on Budgets, Home, Overview, Slack, MCP, pacing alerts and the roll-up cache; `% spent`, pace and "ahead of plan" follow. Nothing flags it. The existing test (`pipeline.test.ts:168`) covers only a byte-identical reload. Spec §14 step 3 prescribes this hash, so the spec needs an ADR too.
*Fix:* hash the business key only (source id + mapped dimension tuple + period_date [+ metric], or an explicit `row_id` mapping role), never the measure or ignored columns; **or** make a run authoritative for the (source, date-range) it covers. Add the test "same logical row, changed amount → one fact, new amount, `spend_month` row count unchanged".

**T-2 · Critical (companion to T-1) · Nothing ever removes facts the source no longer returns.**
No DELETE in the ingest pipeline; incremental connectors cannot observe deletes. A deleted or re-keyed warehouse row (campaign renamed → different tuple) contributes to actuals, pace and alerts forever. Combined with T-1, reruns only ever add.
*Fix:* per-run reconciliation for full-extract sources (mark facts of the source not seen in this run as superseded within the loaded range) or a soft-delete column for incremental sources; expose "facts not seen in the last run" in Sources.

**T-3 · High · Overview `totals`/`assigned`/`unassigned` fall back to the "over pace" list's totals.**
`apps/api/src/modules/overview/overview.ts:126` — `heat` is null unless the workspace has both a `country|market|region` and a `platform|channel` dimension; `:191` `assigned = (heat?.totals ?? over.totals)["budget"]` and `:222` `totals: {...(heat?.totals ?? over.totals)}`, where `over` is filtered to `pace_index ≥ 1.05 AND ahead_of_plan_abs > 0`. `unassigned = headline.budget − assigned`.
*Wrong number:* with a 150M headline and 4M of over-pace leaves, the Budget tile reads "4M split into the budgets below · 146M unassigned".
*Fix:* when `heat` is null run one `LIVE_LEAVES` totals query; add an overview test for a workspace without the default axes.

**T-4 · High (impact depends on the feed) · Projection facts are never FX-converted and carry no currency.**
`apps/workers/src/ingest/pipeline.ts:200` stores the raw value as `valueReporting`; spend facts on the same line go through `FxCache`. `projection_fact` has no `currency`/`fx_rate_id` columns, violating AGENTS §4. A BRL projection feed on a USD workspace shows projected close, variance and the pacing rules `projected_*` about 5× too high.
*Fix:* require a currency on projection mappings, convert with the same `FxCache`, add `currency`/`fx_rate_id`.

**T-5 · High · Demo money is indistinguishable from real money everywhere except Home's banner.**
`packages/db/src/demo.ts` writes approved demo versions and `source_system='demo'` facts into the workspace; the planner, roll-up, pacing, MCP, Slack and exports never filter `demo`. A workspace created with demo data that then receives real budgets shows real + demo totals until purged (and the purge has its own problem, I-3).
*Fix:* exclude `demo` rows by default in the planner unless `includeDemo`, or block real sources while demo rows exist, or banner every numeric screen.

### 2.2 Reported findings (truthfulness pass)

- **T-6 · Medium · "Spend through" in the envelope's currency is converted with today's FX rate**, not the facts' rates (`get-envelope.ts:181-183`, `fx.ts:13-16`); the End dialog's proposed final amount and the released amount drift with FX.
- **T-7 · Medium · Heatmap hides money its own total includes**: row/col margins `limit: 50`, null codes dropped (`overview.ts:127-165`) while the corner prints the all-leaves total; no "No country" row carries the gap.
- **T-8 · Medium · Slack `/budget search` and `/budget list <text>` re-derive numbers from `search_document.numeric_facets`** (`slash/budgets.ts:119-124`), which refresh only on outbox events and compute `% spent` as a float; the card and plain `list` correctly call `runQuery`.
- **T-9 · Medium · Two paces for one budget**: pacing rules, Budgets column, `/query` and MCP count elapsed time *to today*; Home/Overview *to the data* (`elapsedThrough` passed only by `home.ts`/`overview.ts`). ADR-062 acknowledges this as a follow-up; the default under-pace rules open alerts on data that is merely late.
- **T-10 · Medium · `subtree: true` totals double count when the filter matches nested envelopes** (`compile-query.ts:200-209, 371-375`); internal callers avoid it, MCP advertises it.
- **T-11 · Medium · Archived budgets are counted unless the caller filters `status`** (`GET /workspaces/:ws/pacing` and MCP `query_budgets`).
- **T-12 · Medium · Closure reports use live leaves; Budgets/tree/pivot use holdings** (ADR-059) → two "budget" figures for the same period. A recorded decision, still two numbers.
- **T-13 · Low · "Today" is the UTC date everywhere** (server and web); west of UTC, evening pace counts one extra day and the timeline's today line is tomorrow.
- **T-14 · Low · `elapsed` and `daysLeft` both include today** → `runRateNeeded` divides by one day too many; last day shows "100% gone · 1 day left".
- **T-15 · Low · Explorer ignores `/tree`'s `cacheVersion`**, so a stale roll-up is indistinguishable in the UI although the API reports it.
- **T-16 · Low · Display fallbacks print "USD 0.00" for a leaf with no approved version** instead of "—" (`heatmap.tsx`, `headline.tsx`).
- **T-17 · Low · Planner budget pick has no tie-break on `approved_at`** (`ORDER BY approved_at DESC LIMIT 1`) while snapshots add `version_no DESC`.

### 2.3 Done well (truthfulness)
Ratios are ratios of sums with `NULLIF`/`SAFE_DIVIDE`, property-tested. `envelope_dimension` PK prevents fan-out. `unallocated` telescopes exactly; roll-up nodes use 60-digit sums so refresh equals rebuild; `/tree` levels equal `/query` groups on the golden dataset. Totals share the rows' `WHERE`. `actual` equals Σ`spend_fact` by property test; `spend_month` triggers cover insert/update/delete/re-match. Money is Decimal/`NUMERIC(18,2)` end to end; all `z.number()` in `@budget/domain` are counts or percentages; web `Number()` use is display-only. Spend FX is per-fact, per-date, `ROUND_HALF_UP`, with `fx_rate_id`, missing rate rejects the row. No client-side aggregation. Failed fetches render errors, not zeros; pruned months are refused rather than read as 0. Query cache keyed by `dataVersion`. No `Math.random`, faker, mock or placeholder data in any production path.

---

## 3. Data integrity and robustness

### 3.1 Verified findings

**I-1 · Critical · The deployed worker marks an outbox row published even when its handler threw.**
`apps/workers/src/local-runner.ts:85-88` — the `catch` logs and then `UPDATE outbox SET published_at = now()` runs unconditionally. This file *is* `budgetos-worker` (ADR-065, `deploy.yml`). All consumers for a row share one `try`, so an ingest or roll-up failure also skips search and notify for that row. A transient DB timeout during a `facts.loaded` roll-up leaves `rollup_cache` permanently stale, no in-app or Slack notification, no search update; the log says "failed", never "lost". The real at-least-once path (`consumer.ts` + `processed_event`, `outbox-publisher.ts`) exists but is not deployed.
*Fix:* set `published_at` only on success; `attempts`/`last_error` columns; bounded retry with backoff; dead-letter marker (`failed_at`) an operator can list; run each consumer in its own try.

**I-2 · Critical · Exports never run in production.**
`local-runner.ts:33-36` subscribes to ingest ∪ rollup ∪ notify; `packages/domain/src/outbox-topics.ts:23` maps `export.requested` → `export`; `handleExportRequested` is wired only in `apps/workers/src/export/main.ts` and `index.ts`, neither deployed. `POST /api/v1/exports` queues jobs that stay `queued` forever. Exposure is API clients only: the web never calls `/exports` and MCP builds CSV inline.
*Fix:* add `topicsFor("export")` to the runner (and SIGTERM draining, see M-7).

**I-3 · High · "Purge demo data" hard-deletes real facts matched to demo envelopes.**
`packages/db/src/demo.ts:160-162` — `DELETE FROM spend_fact WHERE … (demo OR envelope_id = ANY(demo ids))`, same for kpi/projection, plus every target and alert on those envelopes. Demo envelopes are `APPROVED` and use real registry codes (`BR/MX/US`, `meta`, `google_ads`); `matchRunFacts` (`facts.ts:118-128`) assigns unmatched facts to the most specific non-archived envelope whose tuple is a subset. A real run ingested while demo envelopes exist lands on them; one click on `POST /workspaces/:ws/demo-data/purge` (`user.manage`, no confirmation) deletes those facts. The audit row records counts only.
*Fix:* delete only `demo = true` facts; set `envelope_id = NULL` on non-demo facts so the next run re-matches; refuse (409) when non-demo facts hang off demo envelopes; require a confirm body.

**I-4 · High · Period close writes to BigQuery inside the transaction, holding every period envelope and the workspace row.**
`apps/api/src/modules/closures/commands/close-period.ts:171-172` — `bumpDataVersion` (locks the `workspace` row) then `sink.write` (network I/O: `exists`, `createTable`, N inserts or a load job) before commit, under a 300 s timeout. Every other write in the workspace ends with `bumpDataVersion`, so all of them block behind the close. Worse: `closureTable(workspaceId, period.key, earlier.length)` (`:79`) names the table by committed-closure count; if `createTable` succeeds and an insert fails, the transaction rolls back but the BigQuery table remains, and the next attempt hits `sink.ts:73-74` `CONFLICT "already exists; it is never overwritten"`. **The period cannot be closed again without manual BigQuery surgery** (the runbook says "drop the orphan").
*Fix:* commit the closure as `closing` first, write BigQuery outside the transaction, flip to `closed` in a second transaction (or mark failed and release locks); name the table by `closure.id`.

**I-5 · High · Bulk previews live in per-instance memory on a 3-instance service.**
`deploy.yml` sets no `REDIS_URL` (0 occurrences); `preview-store.ts:62-65` falls back to `MemoryPreviewStore`; `budgetos-app` runs `--min-instances 0 --max-instances 3` with no session affinity. A preview built on instance A and committed on instance B returns `404 "Preview not found or expired"` (`commit.ts:33`, `budget-import.ts:92`). The same applies to the `/query` cache (stale across instances after a write elsewhere) and the MCP rate limiter. ADR-008 itself says memory mode is "not for more than one API instance".
*Fix:* Memorystore + `REDIS_URL` secret, or a Postgres `preview` table with `expires_at` (which also gives atomic `DELETE … RETURNING` consumption); until then `--max-instances 1`.

**I-6 · High · `Idempotency-Key` (spec §17) is not implemented on any of the 121 mutating routes.**
Zero hits for `idempoten` in `apps/api/src` outside doc comments; Redis is wired only for previews. Natural idempotency protects draft edits (`basedOnVersionId`), submit, decide, bulk commit and `rowVersion` edits. Not protected against a retried or double-clicked POST: create envelope, comments/threads, baselines (two snapshots), export jobs, manual-entry batches, experiments, saved views, ingest runs, reintroduce.
*Fix:* interceptor on non-GET routes keyed `(workspaceId, actorId, route, Idempotency-Key)`, stored in a Postgres `idempotency_key` table **inside the same `withTenant` transaction as the write** (a rolled-back write burns nothing), `INSERT … ON CONFLICT DO NOTHING RETURNING` as the lock, replay the stored response.

**I-7 · High · Consumer transactions are capped at 15 s, but whole-workspace rebuilds run inside them.**
`packages/db/src/tenant.ts:44` defaults `timeout: 15_000`; `apps/workers/src/consumer.ts:35` passes no options; `rollup.ts:340-355` rebuilds every template for every cached period on `registry.changed` / `budget.changed kind=granularities|moved` (the explicit rebuild path gives itself 300 s); `search-indexer/indexer.ts:43` re-indexes every envelope on `naming.changed kind=display`. Prisma aborts → in local-runner mode the event is lost (I-1); in push mode it is redelivered forever (no DLQ).
*Fix:* per-consumer `timeoutMs` (rollup/search 300 s) or move rebuilds out of `handleOnce` into a queued job.

**I-8 · Medium · Datastream stream replicates deletes into the "archive".**
`infra/modules/datastream/main.tf:100-108` has no `append_only {}` block, so the BigQuery destination runs in default merge mode and applies source DELETEs; `setup.sql:10` publishes all tables. The retention job (`packages/db/src/retention.ts:48-53`) deletes a month from Postgres only once the replica matches — after which Datastream deletes it from BigQuery too, and `factsPrunedBefore` routes those queries to a replica with no rows: silent zeros. Latent today (`FACT_RETENTION_ENABLED` unset), but the design is wrong as written.
*Fix:* `append_only {}` plus latest-per-key views, or an explicit archive copy before deletion; make retention verify the archive, not the live replica.

### 3.2 Reported findings (integrity sub-passes)

- **I-9 · High · An ingest run can be left `running` forever**: `pipeline.ts:125-143` setup (registry, closed periods, match keys) runs before the `try` whose `catch` writes `failed`; the claim (`queued → running`) already committed; redelivery returns `duplicate`; `queueRun` then refuses new runs ("A run is already running"). Recovery is owner-role SQL per `docs/runbooks/ingest.md`. Same shape for exports (`export.ts:109-115`). *Fix:* lease + stale-run sweeper; wrap setup in the try.
- **I-10 · High · No dead-letter, max-attempt or backoff anywhere**; `infra/` has no Pub/Sub module; `push-server.ts` answers 500 to validation errors too, so one bad payload blocks the workspace's ordering key.
- **I-11 · High · Outbox publisher head-of-line blocking**: one row that always fails (NULL `workspace_id`, missing topic, oversized payload) stays inside the first 500 by id; 500 sequential publishes must fit 60 s. (Not deployed today.)
- **I-12 · High · Ingest commits per 5,000-row chunk**; a crash leaves unmatched partial facts visible to the planner with no `facts.loaded`/`dataVersion` bump, so tree (cache) and pivot (planner) disagree until a rerun.
- **I-13 · Medium · Retention compares totals in one transaction and deletes by date range in another**; a restatement landing between them is deleted unverified.
- **I-14 · Medium · `bumpDataVersion` turns the workspace row into a per-workspace global write lock** (`sql.ts:18-21`, called at the end of every write; a 10k-row bulk commit holds it for seconds; the close holds it through BigQuery).
- **I-15 · Medium · Lock-order inversion between `moveIn` and `decide`** (envelope → parent → request vs request → parent → envelope) → Postgres `40P01` surfaces as a 500; no Prisma error filter exists (`P2002`/`P2034`/`P2028` all become anonymous 500s). Cross-moves (`A under B`, `B under A`) deadlock the same way.
- **I-16 · Medium · Budget CSV import: concurrent commits create duplicate budgets** (plan built outside the transaction; no tuple uniqueness; no advisory lock).
- **I-17 · Medium · `dates` approval applies stale dates without re-validation**; trimmed never-approved children are not held; `lockForWrite` does not block `PENDING`, so a held envelope can still be moved.
- **I-18 · Medium · External evidence has no per-approver duplicate check**; `countedApprovals` counts rows, not deciders (`engine.ts:71-74`), so one requester uploading evidence twice satisfies `minApprovals: 2`. *Fix:* `COUNT(DISTINCT decided_by)` + unique `(request_id, step_index, decided_by)`.
- **I-19 · Medium · SELECT-then-INSERT with no backing constraint**: ingest "run now" (two queued runs), one active target per (envelope, metric), pacing rule names, role assignments. *Fix:* partial unique indexes.
- **I-20 · Medium · `createWorkspace` spans five or more transactions** (header claims one); a mid-way failure leaves a workspace without granularities or admin, and the retry hits `CONFLICT` on the slug.
- **I-21 · Medium · Slack posts happen inside the consumer's DB transaction**; a later failure rolls back the `slack_message` refs while the messages stay in Slack, so later changes re-post instead of editing.
- **I-22 · Medium · Dimension-value merge is an irreversible bulk rewrite with no unmerge**; facts keep the old code in `dimension_values`. `addValues` silently overwrites an existing code; `updateValue` retires values in use with an incomplete `before`.
- **I-23 · Medium · Pacing has no lock across overlapping evaluations** → duplicate `alert.reopened`/`resolved` audit + outbox + Slack posts.
- **I-24 · Medium · Raw-file retention deletes GCS objects before writing the audit row**.
- **I-25 · Medium · `WORKSPACE_RETENTION_DAYS` accepts `0` or `NaN`** (`lifecycle.ts:13`) → purge with no undelete window, or a Prisma error.
- **I-26 · Low · Two unaudited write paths**: `PATCH /org/people/:id` for a person with no workspace role writes `app_user` with zero audit/outbox rows (`org-people.ts:52-58`); `GET /workspace-templates` writes template/tour defaults on every read (`templates.ts:38-59`). `openBlockingThread` and experiment `linkEnvelope` create thread/tag rows under a parent event only.
- **I-27 · Low · No global guard test enumerates commands for the audit+outbox invariant**; coverage is per feature (good, but hand-maintained).
- **I-28 · Low · `reintroduce` takes no lock on the ended source** → two successors.
- **I-29 · Low · Outbox payloads used without zod in rollup/search/slack/in-app handlers** (envelope is validated, payload is not).
- **I-30 · Low · Incremental `since` has no overlap window**; FX lookup takes the latest rate of any age.
- **I-31 · Info · Seed, reset and load tooling have no production guard**; the seed is additive (would pollute, not destroy); `load/main.ts` runs `ALTER ROLE budget_app SET statement_timeout` cluster-wide.

### 3.3 Schema constraints

_(The schema-constraint consolidation pass had not reported when this document was written; its concrete findings — missing partial uniques, nullable columns, check constraints — are folded into I-18, I-19 and plan item W3-3. The section will be completed when the pass reports.)_

### 3.4 Done well (integrity)
Every API command (52 files audited) pairs audit and outbox in one `withTenant` transaction via shared helpers; versions are only ever `UPDATE`d on lifecycle fields, never amount or phasing; `writeDraftVersion` supersedes, never deletes; preview-then-commit everywhere many rows change, with author/workspace binding, TTL and in-transaction re-check; id-ordered `FOR UPDATE` on envelopes, parent-cap check under the parent lock with a DB trigger backstop; partial unique indexes where "one open row" matters (closure, allocation, alert, naming template); approvals lock the request before reading state, so double-advance and approve-after-withdraw are impossible; outbox claim is `FOR UPDATE SKIP LOCKED` with publish-then-mark and `processed_event` dedupe tied to a visible outbox row by RLS; roll-ups serialised per workspace by advisory lock; retention is off by default, compares to the cent, stops at the first mismatch; purge covers all 54 tenant tables in FK-safe order and keeps `audit_event` plus a tombstone; no migration was ever modified after landing (`git log --diff-filter=M` is empty); no `console.*`, no empty catches, no unawaited writes.

---

## 4. Maintainability

### 4.1 Verified findings

**M-1 · Critical · Every push to `main` deploys to production with no tests run.**
`.github/workflows/ci.yml` runs `pnpm install`, `pnpm lint`, `pnpm typecheck` and exactly one vitest file (the MCP import guard). No unit tests, no acceptance, no e2e, no bench, no `license-check`, no `pnpm audit`, no Postgres service. `deploy.yml` triggers on `push: branches: [main]` and `workflow_dispatch` with no `needs:`/`workflow_run` on CI and no `environment:` protection. 69 of 132 unit-test files need Postgres. The gate in `docs/LOCAL_BUILD_PHASES.md:81` is a laptop gate. Branch protection is unverifiable from the repo.
*Fix:* `test` job with `services: postgres:16, redis:7`, `pnpm db:migrate && pnpm test && pnpm license-check && pnpm audit --prod --audit-level=high` (acceptance on `main`); deploy `on: workflow_run` of CI gated on success; GitHub `environment: production` with a required reviewer.

**M-2 · High · Migrations run before the new code ships, forward-only, with no rollback story.**
`deploy.yml` runs `prisma migrate deploy && bootstrap.ts` as a job, then deploys the services, so the old revision serves the new schema for minutes; nothing documents expand/contract; no down migrations; a failed job leaves `_prisma_migrations` needing `migrate resolve` by hand and the runbook only says "look at the logs".

**M-3 · High · The API has no structured logger.**
`apps/api/package.json` has no `pino`; `main.ts` uses Nest defaults; `requestId` is generated (`tenant.interceptor.ts:50`) and written to audit rows but never logged or returned; `DomainExceptionFilter` is the only filter, so every Prisma/unknown error is an anonymous 500 with no correlation id. AGENTS §4 requires pino with `requestId`, `workspaceId`, `actorId`.
*Fix:* `nestjs-pino` or Fastify `logger: pino`, request-scoped child logger, catch-all filter mapping `P2002`/`P2034` → 409 and `P2028` → 503, `X-Request-Id` response header, `redact` for cookies/authorization.

**M-4 · Medium · Docs drift.** Three ADR number collisions (`0030`, `0034`, `0065`; `README.md` omits `0065-slack-toolset`). `TASKS_STATUS.md:64` keeps T-008 (Terraform + CI deploy) pending while production is live by hand. `docs/runbooks/exports.md` describes an `export-worker` push subscriber and a 7-day lifecycle rule that do not exist. AGENTS §3 describes `pnpm dev` and `pnpm db:seed --size` that do not match `package.json`. Only `packages/grid` and `packages/timeline` have READMEs.

**M-5 · Medium · No env schema; `.env.example` covers 18 of ~45 keys.** `AUTH_MODE`, `AUTH_AUDIENCE`, `OPENAI_*`, `MCP_PUBLIC_URL`, `PACING_*`, `WORKSPACE_RETENTION_DAYS`, `UPLOAD_BUCKET`, `SESSION_KEY`, `MCP_OAUTH_KEY`, `WEB_DIST`, `PUBLIC_ROUTES` and others are read but undocumented; `process.env["DATABASE_URL"] ?? ""` fails late with a Prisma connection error.
*Fix:* zod env schema per service parsed at boot; a root `.env.example`.

**M-6 · Medium · Dockerfile**: single stage, `COPY . .`, all devDependencies installed, root user, `tsx` at runtime (25–30 s cold start, admitted in `deploy.yml`).

**M-7 · Medium · No graceful shutdown**: `local-runner.ts` `for (;;)` with no SIGTERM handler (Cloud Run gives 10 s); the API never calls `enableShutdownHooks()`; no readiness check touches the DB; worker health answers 200 to every path; no metrics, tracing, or alerting on worker failures or outbox backlog.

### 4.2 Reported findings

- **M-8 · Medium · SQL strings outside `packages/db`/`query-planner`**: 85 raw call sites in `apps/` (local-runner 7, retention 4, purge 3 plus a 50-line DELETE table, slack notify 3, run-query 3, pacing 3, overview, lifecycle, manual-entry, bootstrap, load tooling). AGENTS §4 says SQL lives only in the two packages.
- **M-9 · Medium · `apps/api` depends on `@budget/workers`** (10 non-test imports: `templateNodes`, `loadRegistry`, `FxCache`, `ObjectStore`, `exportTable`, Slack block helpers), inverting the spec's dependency direction and dragging `@google-cloud/pubsub`, `snowflake-sdk`, `@googleapis/sheets` into the API graph. *Fix:* a shared package for object store, registry loader, FX cache, Slack blocks, money formatting.
- **M-10 · Low · Duplicated helpers**: `pct` ×10 (with differing rounding), `money` ×8, `esc` ×3, `loadEnv` ×7.
- **M-11 · Low · Web unit tests**: 0 `.test.tsx`; `vitest.config.mjs` includes only `src/**/*.test.ts`, so a `.test.tsx` would silently not run; the largest components (`w.$ws.budgets.tsx` 562 lines, `shell.tsx` 522, `structure-dialog.tsx` 471, `mapping-wizard.tsx` 400) rely on e2e only, and e2e never runs in CI.
- **M-12 · Low · Dependency hygiene**: no Renovate/Dependabot; 99 packages at >1 version (zod 3+4, vite 5+6, esbuild 0.21+0.25); `packages/grid` lists `lodash`, `marked@4`, `react-responsive-carousel` as runtime deps (likely leftovers); TanStack router version skew.
- **M-13 · Low · `packages/db` typecheck script hardcodes port 5432**; compose has no named volumes or healthchecks.

### 4.3 Done well (maintainability)
0 `any`, 0 `@ts-ignore`, 1 `eslint-disable`; strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` in every package; exact-pinned dependencies with a pnpm catalog; licence gate with reviewed exceptions and a commercial-package ban enforced in both eslint and the licence script; 132 unit-test files including property tests and golden assertions, 36 Playwright flows including a11y, OpenAPI and generated-client drift tests, a nightly load job that records honest failures; small files (~95 lines average in the API), commands/queries split honoured, zod at every boundary, i18n at ~100%, no `console.log`, no client-side aggregation; ADRs that honestly record deviations.

---

## 5. Backups and data loss

**B-1 · Critical · Production Postgres is hand-made and its protection is not in code or docs.**
Cloud SQL `dmus-gonzalo:us-central1:budgetos-db` was "created once by hand" (`docs/runbooks/deploy.md`, ADR-065). `infra/` holds only `bigquery` and `datastream`; the `infra/modules/cloudsql` the spec promised (PITR 7 days, read replica) does not exist. The plan's commitments ("Cloud SQL PITR 7 days + daily export to GCS (35-day retention)", "quarterly restore drill") appear nowhere in code, workflows or runbooks. **Automated backups, PITR, deletion protection and HA are Unverifiable from the repo**, and the local `gcloud` session needs re-authentication. There is no restore runbook, no DR procedure, no RPO/RTO. Snapshots (`budget_baseline`) live in the same database and would be lost with it.
*Check now* (read-only):
```bash
gcloud auth login && gcloud sql instances describe budgetos-db --project dmus-gonzalo --format='yaml(settings.backupConfiguration,settings.deletionProtectionEnabled,settings.availabilityType,settings.tier)'
```
*Fix:* `infra/modules/cloudsql` (import the instance), `backup_configuration { enabled, point_in_time_recovery_enabled, transaction_log_retention_days = 7, backup_retention_settings { retained_backups = 35 } }`, `deletion_protection = true`; `docs/runbooks/restore.md` with a dated drill; paste the current settings into `deploy.md` meanwhile; add `gcloud sql backups create` before the migrate job.

**B-2 · High · Event loss and lost exports in the deployed worker** — see I-1, I-2.

**B-3 · High · Demo purge deletes real facts** — see I-3.

**B-4 · Medium · GCS bucket `dmus-gonzalo-budgetos-uploads`**: hand-created; versioning, lifecycle and retention Unverifiable; the 7-day export lifecycle rule ADR-017 deferred to "Terraform phase 20" never happened; MCP exports accumulate (S-17).

**B-5 · Medium · Workspace purge** (ADR-052) after `WORKSPACE_RETENTION_DAYS` (default 30, accepts 0) hard-deletes versions, approvals, comments, snapshots and facts; keeps `audit_event` and a tombstone. The UX plan said the purge exports the audit trail to GCS first; `purge.ts` does not. *Fix:* floor the window at 7 days; pre-purge export.

**B-6 · Medium · Fact retention + Datastream merge mode would delete the archive** — see I-8. Off today.

**B-7 · Medium · Seed/reset have no production guard** (`scripts/dev-reset.sh`, `apps/api/src/seed/golden.ts`); with the Cloud SQL proxy and `.env` pointed at it, `pnpm db:seed` would seed production. *Fix:* refuse unless host is local or `ALLOW_REMOTE_SEED=1`.

**B-8 · Low · Redis**: not deployed; only ephemeral state (previews, query cache, rate limits) would live there — correctness across instances is the issue (I-5), not durability.

**B-9 · Info · Exports are not a backup path**: the export worker does not run in production (I-2); MCP CSV is inline; no whole-workspace or audit-log export exists.

**B-10 · Done well · Audit log immutability**: `audit_event_immutable` trigger raises on UPDATE/DELETE; RLS forced; `budget_mcp` INSERT-only; `budget_publisher` no access; partitions proven unreachable by the app role; purge keeps audit rows. Only the owner role (used by the worker, S-2) bypasses RLS, and even it is blocked by the trigger.

---

## 6. Recommended order of work

Each line is roughly one PR.

1. **T-1/T-2** — business-key fact hash (or run-authoritative reload) + reconciliation + test; ADR amending spec §14. *Stops money inflating.*
2. **I-1/I-2/M-7** — worker: publish only on success, attempts + dead-letter, subscribe to `export`, SIGTERM drain, log-based alert on failures and backlog. *Stops silent loss.*
3. **M-1** — CI test job with Postgres, license-check, audit; deploy gated on CI and a production environment. *Stops untested deploys.*
4. **B-1** — Cloud SQL under Terraform with PITR/backups/deletion protection; `restore.md` and a drill. *Makes recovery possible.*
5. **T-3** — Overview totals when no heatmap axes; **I-3** — demo purge scoped to demo rows; **I-5** — Redis or `max-instances 1`.
6. **S-5, S-6** — `safeNext`, helmet, scoped form parser, POST logout, rate limits. **S-3, S-2** — remove the owner fallback and the owner-role worker. **S-4** — audit insert policy. **S-1** — `projectId` regex. **S-8** — Fastify override.
7. **I-4** — close-period: BigQuery outside the transaction, table named by closure id. **I-6/I-15** — idempotency keys + Prisma error filter (one PR). **I-7** — consumer timeouts.
8. **T-4, T-5** — projection currency; demo filter in the planner. **T-8/T-9/T-10/T-11** — single query path for Slack search, `elapsedThrough` as a request option, subtree totals, archived default.
9. **M-3, M-5** — pino + requestId + env schemas. **S-11/S-12** — session and refresh-token store. **S-13** — per-service SAs.
10. **M-4, M-6, M-8, M-9** — docs renumbering and corrections, multi-stage non-root image, SQL back into `@budget/db`, shared package to break api→workers.

## 7. Things that could not be verified from the repo

| Item | How to check |
|---|---|
| Cloud SQL backups, PITR, deletion protection, HA | command under B-1 |
| Branch protection on `main` | GitHub → Settings → Branches |
| Worker SA's BigQuery grants (S-1 exploitability) | `gcloud projects get-iam-policy dmus-gonzalo --flatten=bindings[].members --filter=bindings.members:budgetos-runtime` |
| GCS bucket versioning/lifecycle | `gcloud storage buckets describe gs://dmus-gonzalo-budgetos-uploads` |
| Secret Manager access per SA (S-13) | `gcloud secrets get-iam-policy budgetos-app-database-url` |

---

## 8. Status

Updated by each fix PR (see `docs/STACK_HARDENING_PLAN.md`). `—` = no work item (accepted as-is or informational).

| ID | Severity | Plan item | Status |
|---|---|---|---|
| S-1 | High (impact Suspected) | W2-5 | open |
| S-2 | Medium | W2-3 | open |
| S-3 | Medium | W2-3 | open |
| S-4 | Medium | W2-4 | open |
| S-5 | Medium | W2-1 | open |
| S-6 | Medium | W2-2 | open |
| S-7 | Medium | W2-5 | open |
| S-8 | Medium | W2-6 | open |
| S-9 | Low | W2-7 | open |
| S-10 | Low | W2-8 | open |
| S-11 | Medium | W5-3 | open |
| S-12 | Medium | W5-3 | open |
| S-13 | Medium (infra) | W5-4 | open |
| S-14 | Low | W5-7 | open |
| S-15 | Low | W5-7 | open |
| S-16 | Low | W2-2 | open |
| S-17 | Low | W2-2 | open |
| S-18 | Low | W2-5 | open |
| S-19 | Low | W2-5 | open |
| S-20 | Low | W2-2 | open |
| S-21 | Info | W2-3 | open |
| S-22 | Info | — | open |
| T-1 | Critical | W1-1 | open |
| T-2 | Critical (companion to T-1) | W1-1 | open |
| T-3 | High | W1-3 | open |
| T-4 | High (impact depends on the feed) | W4-1 | open |
| T-5 | High | W1-4 | open |
| T-6 | Medium | W4-3 | open |
| T-7 | Medium | W4-3 | open |
| T-8 | Medium | W4-2 | open |
| T-9 | Medium | W4-2 | open |
| T-10 | Medium | W4-2 | open |
| T-11 | Medium | W4-2 | open |
| T-12 | Medium | D-1 | open |
| T-13 | Low | W4-4 | open |
| T-14 | Low | W4-4 | open |
| T-15 | Low | W4-4 | open |
| T-16 | Low | W4-4 | open |
| T-17 | Low | W4-4 | open |
| I-1 | Critical | W1-2 | open |
| I-2 | Critical | W1-2 | open |
| I-3 | High | W1-4 | open |
| I-4 | High | W3-1 | open |
| I-5 | High | W0-4/W1-5 | open |
| I-6 | High | W3-2 | open |
| I-7 | High | W1-2 | open |
| I-8 | Medium | W3-7 | open |
| I-9 | High | W3-4 | open |
| I-10 | High | D-3 | open |
| I-11 | High | D-3 | open |
| I-12 | High | W3-4 | open |
| I-13 | Medium | W3-7 | open |
| I-14 | Medium | W3-8 | open |
| I-15 | Medium | W3-2 | open |
| I-16 | Medium | W3-6 | open |
| I-17 | Medium | W3-5 | open |
| I-18 | Medium | W3-3 | open |
| I-19 | Medium | W3-3 | open |
| I-20 | Medium | W3-2 | open |
| I-21 | Medium | W3-6 | open |
| I-22 | Medium | — | open |
| I-23 | Medium | W3-6 | open |
| I-24 | Medium | W3-9 | open |
| I-25 | Medium | W3-9 | open |
| I-26 | Low | W3-9 | open |
| I-27 | Low | W3-3 | open |
| I-28 | Low | W3-3 | open |
| I-29 | Low | W1-2 | open |
| I-30 | Low | W1-1 | open |
| I-31 | Info | W0-3 | open |
| M-1 | Critical | W0-1 | open |
| M-2 | High | W0-2 | open |
| M-3 | High | W5-1 | open |
| M-4 | Medium | W5-5 | open |
| M-5 | Medium | W5-2 | open |
| M-6 | Medium | W2-8 | open |
| M-7 | Medium | W1-2/W5-8 | open |
| M-8 | Medium | W5-6 | open |
| M-9 | Medium | W5-6 | open |
| M-10 | Low | W5-6 | open |
| M-11 | Low | W5-9 | open |
| M-12 | Low | — | open |
| M-13 | Low | W5-5 | open |
| B-1 | Critical | W0-2 | open |
| B-2 | High | W1-2 | open |
| B-3 | High | W1-4 | open |
| B-4 | Medium | W5-8 | open |
| B-5 | Medium | W3-9 | open |
| B-6 | Medium | W3-7 | open |
| B-7 | Medium | W0-3 | open |
| B-8 | Low | D-2 | open |
| B-9 | Info | W1-2 | open |
| B-10 | Done well | — | open |
