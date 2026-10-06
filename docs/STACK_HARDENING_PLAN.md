# Stack hardening plan — order of work and model assignment

Companion to `docs/STACK_AUDIT_2026-10-04.md` (finding IDs S-/T-/I-/M-/B- refer to it). Every item is one PR in its own worktree, built the AGENTS.md way: write the "Done when" test first, implement the smallest change, `pnpm typecheck && pnpm lint && pnpm test && pnpm license-check`, update `docs/TASKS_STATUS.md`, PR template §7.

## Model policy

| Model | Use for | Why |
|---|---|---|
| **Haiku 4.5** | Mechanical, fully specified edits: regexes, config, overrides, doc renumbering, one-line deploy flags, env examples, small guards with an obvious test | Cheapest; the audit already states file, line and fix |
| **Sonnet 5** | Standard implementation with tests: new migration + RLS test, a service change plus its vitest, CI workflows, Terraform modules, Dockerfile, logging | Reliable on well-scoped engineering where the design is settled |
| **Opus 5.5** | Design-bearing work: changes to data identity, transaction boundaries, lock order, retry semantics, approval semantics, anything that needs an ADR | Needs judgement about invariants and failure modes |
| **Fable 5.1** | **Review only**: adversarial review of each wave's PR stack, re-running the audit's verification checklist, final sign-off | Reserved for the step where a missed subtlety costs the most |
| **You (human)** | GCP console actions the deployer cannot do, product decisions (D-1..D-3 below) | Not automatable or not the agent's call |

Sizes: **S** ≤ 2 h of agent work, **M** half a day, **L** a day or more. "Deps" are hard prerequisites; everything else in a wave can run in parallel in separate worktrees (memory: never work in `BudgetOS-real`).

Run pattern per item: open a worktree on `main`, start the assigned model with the item's text below as the prompt, pointing it at the audit finding for file:line evidence. Fable reviews the wave once all its PRs are green.

---

## Wave 0 — Safety net (do first, all parallel)

Nothing else should merge to `main` until W0-1 is in, because today a merge deploys untested.

| ID | Item | Model | Size | Deps | Done when |
|---|---|---|---|---|---|
| **W0-1** | **CI gate + deploy dependency** (M-1, S-8 audit step). `ci.yml`: add a `test` job with `services: postgres:16, redis:7, fake-gcs-server`, env overrides as in `docs/runbooks/local.md`, run `pnpm db:migrate`, `pnpm test`, `pnpm license-check`, `pnpm audit --prod --audit-level=high`; keep lint/typecheck job. `deploy.yml`: `on: workflow_run` of `ci` on `main`, gated on `conclusion == success`; add `environment: production`. | Sonnet | M | — | A PR with a failing unit test is red in CI; a push to `main` with red CI does not run deploy; green CI deploys as before |
| **W0-2** | **Cloud SQL under Terraform + restore runbook** (B-1). Human first: run the `gcloud sql instances describe` command from the audit and paste the output into the PR. Agent: `infra/modules/cloudsql` with `backup_configuration` (enabled, PITR, 7-day tx logs, 35 retained), `deletion_protection = true`, `terraform import` instructions; `docs/runbooks/restore.md` (clone-from-PITR, swap connection secret, verify `_prisma_migrations`, drill log table); mention RPO/RTO in ADR-065. | Sonnet (+ human) | M | human output | Module plans clean against the imported instance; runbook has a dated first drill entry |
| **W0-3** | **Seed/reset/load production guard** (B-7, I-31). `packages/db/src/env-guard.ts`: refuse when the DB host is not local unless `ALLOW_REMOTE_DB=1`; call it from `seed/golden.ts`, `scripts/dev-reset.sh` (via a tiny node check), `apps/api/src/load/*`, `apps/api/src/seed/golden.ts`. Also drop the cluster-wide `ALTER ROLE budget_app SET statement_timeout` in `load/main.ts` for a session-level `SET`. | Haiku | S | — | Test: seed against a non-local URL throws before any write |
| **W0-4** | **Pin the app to one instance until Redis exists** (I-5 stop-gap). `deploy.yml`: `--max-instances 1` on `budgetos-app`; comment pointing at W1-5. | Haiku | S | — | Deploy succeeds; comment present |

| **W0-5** | **Worker test isolation** (added 2026-10-05: the first CI runs showed `apps/workers` `notify.test.ts` failing about every other run with an empty inbox where `approval_requested` was expected, plus an unhandled rejection; the API suite seeds the same database first). Root-cause and fix fixture isolation; relax the `singleFork`/`VITEST_MAX_WORKERS=1` workarounds only if stable 5× in a row. | Sonnet | M | W0-1 | Workers suite green 5× in a row in CI conditions |

**Fable review gate 0**: CI config review (is anything still able to skip the gate?), Terraform plan diff, guard test coverage.

---

## Wave 1 — Stop wrong money and lost events

| ID | Item | Model | Size | Deps | Done when |
|---|---|---|---|---|---|
| **W1-1** | **Fact identity redesign** (T-1, T-2). ADR amending spec §14 step 3: the dedupe key is the business key (source id + mapped dimension tuple + `period_date` [+ metric] or an explicit `row_id` mapping role), never the measure or ignored columns; a run over a (source, date-range) is authoritative — facts of that source in the range not seen in the run are marked `superseded_at` (new nullable column, filtered by planner, `spend_month` trigger and roll-up). Migration adds `natural_key_hash` + `superseded_at`, backfills, swaps the unique index. Incremental connectors keep upsert semantics; full-extract connectors (CSV, Sheets) get reconciliation. Sources UI shows "N facts superseded". | **Opus** | L | W0-1 | Tests: (a) same logical row with changed amount → one fact, new amount, `spend_month` count unchanged; (b) row missing from a full re-extract → superseded, not counted; (c) golden assertions unchanged; `pnpm bench` planner unchanged |
| **W1-2** | **Production worker reliability** (I-1, I-2, I-7, M-7). Migration: `outbox.attempts int default 0`, `last_error text`, `failed_at timestamptz`, partial index on unpublished. `local-runner.ts`: per-consumer `try`, `published_at` only when all consumers succeeded, otherwise `attempts+1`, exponential backoff by `attempts`, `failed_at` after 8; subscribe to `topicsFor("export")` and call `handleExportRequested`; SIGTERM → stop loop, finish current row, exit 0. `consumer.ts`: per-consumer `timeoutMs` (rollup/search 300 s). Runbook `worker.md`: how to list and replay `failed_at` rows. | Sonnet | M | W0-1 | Tests: a throwing handler leaves the row unpublished with `attempts=1`; 8 failures set `failed_at`; an `export.requested` row produces a completed export; SIGTERM mid-pass exits after the row |
| **W1-3** | **Overview totals without heatmap axes** (T-3). When `heat` is null, run one `LIVE_LEAVES` totals query and use it for `assigned`, `unassigned`, `totals`. | Sonnet | S | — | Test in `overview.test.ts`: workspace with no country/platform dimensions reports `assigned == Σ leaf budgets`, not the over-pace subset |
| **W1-4** | **Demo money isolation** (I-3, T-5). `purgeDemoData`: delete only `demo = true` facts; `UPDATE … SET envelope_id = NULL, match_method = NULL` for non-demo facts on demo envelopes; 409 when any non-demo target hangs off a demo envelope; route requires `{ confirm: true }`. Planner: `e.demo = false` by default, `includeDemo` option used only by Home's demo banner query. | Sonnet | M | — | Tests: real fact matched to a demo envelope survives purge and is re-matched on the next run; `/query` totals exclude demo unless `includeDemo` |
| **W1-5** | **Preview store in Postgres** (I-5 permanent). Table `bulk_preview(id, workspace_id, author_id, payload jsonb, expires_at)` with RLS; `PreviewStore` implementation with `DELETE … RETURNING` consumption; keep the Redis implementation for local; `deploy.yml` back to `--max-instances 3`. | Sonnet | M | W0-4 | `preview-store` tests pass for the Postgres store; preview on one process, commit on another succeeds (test spins two `PrismaClient`s) |

**Fable review gate 1**: re-verify T-1 end to end on the golden dataset with a hand-crafted restatement; read the new ADR against spec §14 and ADR-054; check W1-2 for the "partial consumers" case; confirm no new SQL outside `packages/db`.

---

## Wave 2 — Security quick wins (all parallel, mostly cheap)

| ID | Item | Model | Size | Deps | Done when |
|---|---|---|---|---|---|
| **W2-1** | **`safeNext` open redirect** (S-5). Parse with `new URL(next, "https://x")`, require `origin === "https://x"` and pathname starting with `/`; add `/\\evil`, `/%5Cevil`, `/\evil` cases. | Haiku | S | — | `google-login.test.ts` new cases pass |
| **W2-2** | **HTTP hardening** (S-6). `@fastify/helmet` with a CSP that the SPA and Glide grid actually pass under (`script-src 'self'`, `style-src 'self' 'unsafe-inline'`, `img-src 'self' blob: data:`, `frame-ancestors 'none'`), HSTS; register the form parser only for `/api/v1/slack/*`; `Origin`/`Sec-Fetch-Site` check on non-GET `/api/v1/*` in session mode; `POST /auth/logout` (web updated); `@fastify/rate-limit` on `/auth/*`, `/oauth/*` by IP and on search + AI routes by user. | Sonnet | M | — | Permission-matrix and e2e `routes.spec` still green; test: JSON write with a form body → 415; cross-origin POST → 403; headers asserted in a serve-web test |
| **W2-3** | **No owner role in request paths** (S-2, S-3). `common.module.ts`: only `APP_DATABASE_URL`, plus a boot check that refuses a `rolbypassrls` role. `local-runner.ts`: outbox loop on `PUBLISHER_DATABASE_URL`, workspace discovery via a `budget_publisher`-readable view (migration grants `SELECT(id, org_id, status, deleted_at, created_at)`); `deploy.yml`: worker gets `PUBLISHER_DATABASE_URL`, loses `DATABASE_URL`. | Sonnet | M | W1-2 | Test: API refuses to boot on an owner URL; worker test runs against the publisher role |
| **W2-4** | **`audit_event` insert policy + NOT NULL** (S-4). Migration: policy `WITH CHECK (workspace_id = ANY((SELECT app_visible_workspace_ids())::uuid[]))`; backfill NULLs (org-level rows → keep a separate `org_audit` policy branch on `org_id`), then `NOT NULL`. | Sonnet | M | — | `rls.envelope.test.ts`: insert into another workspace's trail fails; MCP role can still insert its own |
| **W2-5** | **Input and output hygiene bundle** (S-1, S-18, S-7, S-19). `projectId` and `account` regexes; shared `csvCell` in `@budget/domain` used by the three writers; LIKE escape helper used in `compile-filter.ts`, `compile-search.ts`. | Haiku | S | — | Zod tests reject `` x`.y``; CSV tests prefix `'` for `=+-@`; planner test with `%` in a value matches literally |
| **W2-6** | **Dependency overrides** (S-8). `pnpm.overrides`: fastify 5.12.5, lodash 4.18.x, toml 4.2.x, js-yaml 5.4.x; bump vitest/vite in the catalog; ADR-004-style note for the fastify minor. | Haiku | S | — | `pnpm audit --prod --audit-level=high` is clean; permission matrix green |
| **W2-7** | **Roles created `NOLOGIN`** (S-9). New migration: `ALTER ROLE … NOLOGIN` for the three app roles; `bootstrap.ts` does `ALTER ROLE … LOGIN PASSWORD …`; runbook note that bootstrap must run before traffic (it does, in the migrate job). | Sonnet | S | — | Fresh-DB test: roles cannot log in until bootstrap ran |
| **W2-8** | **Multi-stage, non-root image** (S-10, M-6). Build stage compiles with `tsc` (or esbuild) per app, `pnpm deploy --prod` into the runtime stage, `USER node`, `--cpu-boost` on `budgetos-app`. | Sonnet | M | — | Image runs all four commands; cold start measured < 10 s; `docker run --rm image id -u` ≠ 0 |

**Fable review gate 2**: CSP actually enforced in the browser (Playwright run with console errors asserted), the `Origin` check does not break Slack or MCP, the audit policy migration against a copy of production data.

---

## Wave 3 — Integrity under concurrency

| ID | Item | Model | Size | Deps | Done when |
|---|---|---|---|---|---|
| **W3-1** | **Period close outside the transaction** (I-4). Tx 1: lock envelopes, create `period_closure` as `closing` with `bq_table = closure.id`-based name, audit/outbox, bump. Outside: `sink.write`. Tx 2: flip to `closed` (or `failed` + release locks + audit). `restate` and `readsPrunedFacts` treat `closing` as not closed. Runbook `closures.md` loses the "drop the orphan" step. | **Opus** | M | — | Tests: sink failure leaves `failed` closure, envelopes unlocked, next close succeeds with a new table name; concurrent closes → one `closed`, one 409 |
| **W3-2** | **Idempotency-Key + Prisma error filter** (I-6, I-15). Catch-all exception filter mapping `P2002`/`P2034`/`40P01` → 409, `P2028` → 503, everything else → 500 with `requestId`; `idempotency_key(workspace_id, actor_id, key, route, status, response, created_at)` with RLS and a 24 h sweep in the worker; interceptor runs `INSERT … ON CONFLICT DO NOTHING RETURNING` inside the command's `withTenant` (helper `withIdempotency(tx, …)`) and replays on conflict. Web client sends a UUID key on every mutation. | **Opus** | L | W1-2 (sweep) | Tests: two identical POSTs → one envelope, identical responses; a rolled-back write does not burn the key; concurrent duplicates: one executes, one replays |
| **W3-3** | **Constraints the code assumes** (I-18, I-19, I-28). Partial uniques: `ingest_run(source_id) WHERE status IN ('queued','running')`, `target(envelope_id, metric_key) WHERE status='active'`, `pacing_rule(workspace_id, name) WHERE deleted_at IS NULL`, `role_assignment(...)`, `approval_decision(request_id, step_index, decided_by)`, `envelope_lineage(from_envelope_id) WHERE kind='continues'`; `countedApprovals` → `COUNT(DISTINCT decided_by)`; `reintroduce` locks the source. | Sonnet | M | W3-2 (filter) | Each constraint has a test that the race now yields 409, not a duplicate |
| **W3-4** | **Ingest and export leases** (I-9, I-12). `started_at` + `lease_until` on `ingest_run`/`export_job`; setup moved inside the `try`; worker sweeper fails stale runs with audit + outbox and re-queues once; ingest emits `facts.loaded` + bump from the failure path so caches converge. | Sonnet | M | W1-2 | Tests: a run whose setup throws ends `failed`; a run older than the lease is swept and re-queued once |
| **W3-5** | **Dates approval re-validation** (I-17). In `finalizeBulk` before `applyDates`: re-lock, re-run parent-range and children checks, refuse with CONFLICT and move the request to `CHANGES_REQUESTED` if parent or `row_version` changed; hold every line; `lockForWrite` refuses `PENDING` for move/dates/end. | **Opus** | M | — | Tests for the two interleavings in the audit (moved under a shorter parent; child re-dated meanwhile) |
| **W3-6** | **Advisory locks where the code races** (I-16, I-23, I-21). Import commit: `pg_advisory_xact_lock(hashtext(ws||':budget-import'))`; pacing transitions: `UPDATE … WHERE status = expected` with row-count check; Slack: write `slack_message` intents in the tx, post after commit keyed by `(outbox_id, channel, about)`. | Sonnet | M | — | Tests: two concurrent imports of the same preview → one set of budgets; double evaluation → one `alert.reopened`; a failed second post does not lose the first message's `ts` |
| **W3-7** | **Replica append-only + retention same-tx** (I-8, I-13). `append_only {}` on the Datastream stream and latest-per-key views in `infra/modules/bigquery`; retention re-counts inside the delete transaction and aborts on change; ADR-054 amended. | Sonnet | M | — | Terraform plan shows append-only; retention test: a fact inserted between compare and delete aborts the month |
| **W3-8** | **`bumpDataVersion` hotspot** (I-14). Move the bump to a separate `workspace_data_version` row updated as the **first** statement of every write (consistent order, shortest critical section), or compute the version from `max(outbox.id)` per workspace on read; keep the cache key semantics. | **Opus** | M | — | Bench: bulk commit no longer blocks a concurrent single edit; `/query` cache still invalidates on write |
| **W3-10** | **Fact-partition creation deadlock** (found by the W0-1 CI run, 2026-10-05: `40P01` between `ensure_fact_partitions` taking `AccessExclusiveLock` on a new partition and a concurrent statement holding `ShareUpdateExclusiveLock` on the parent, when two API test files seed in parallel). Reproduce with two concurrent `withTenant` writers that both trigger partition creation; fix in `ensure_fact_partitions` (take the creator advisory lock before any DDL, create with `IF NOT EXISTS`, and never run inside the caller's long transaction — or pre-create partitions for the next N months from the worker daily pass). Then remove the `VITEST_MAX_WORKERS=1` CI workaround. | **Opus** | M | W0-1 | Concurrency test: 4 writers × 5 attempts, no `40P01`; CI back to 3 workers |
| **W3-11** | **Database-enforced invariants** (audit I-32, I-34, I-35, I-37, I-38; schema pass of 2026-10-05). One expand-safe migration series: FKs on every `workspace_id` and the version/dimension/target/alert/closure/run pointers (`NOT VALID` then `VALIDATE CONSTRAINT` so the deploy job never takes a long lock); `envelope.parent_id` → `RESTRICT`; CHECKs for date order, currency shape and the text status enums; `outbox.workspace_id` and the array columns `NOT NULL`; `DEFAULT` partitions on the three fact tables and `audit_event` plus a daily partition-extension pass in the worker; the missing hot-path indexes. Each constraint has a test that the violation is now refused. | Sonnet | L | W1-1, W1-2 | `pnpm db:migrate` on a copy of production data succeeds; every listed constraint exists; suites green |
| **W3-9** | **Small integrity fixes** (I-24, I-25, I-26). Raw-file retention audits before deleting; `WORKSPACE_RETENTION_DAYS` parsed with zod, floor 7; `updateOrgPerson` writes an org-level audit + outbox even with zero workspaces; `listTemplates` no longer writes on GET (defaults created on workspace creation only). | Haiku | S | — | One test each |

**Fable review gate 3**: lock-order walk of `moveIn`/`decide`/`close`/`finalizeBulk` after the changes; idempotency replay semantics against spec §17; Datastream config against the retention job.

---

## Wave 4 — Truthfulness, second tier

| ID | Item | Model | Size | Deps | Done when |
|---|---|---|---|---|---|
| **W4-1** | **Projection currency** (T-4). Mapping requires a currency for projection sources (default from the source's declared currency); `projection_fact` gains `currency`, `fx_rate_id`; pipeline converts with `FxCache`; migration backfills existing rows as reporting currency with a one-time audit row. | Sonnet | M | W1-1 | Test: BRL projection on a USD workspace converts at the fact's date |
| **W4-2** | **One query path everywhere** (T-8, T-9, T-10, T-11). Slack search/list resolve ids then `runQuery`; `elapsedThrough` becomes a `QueryRequest` option (`"today" \| "data"`) defaulting to `"data"` for pacing rules, Budgets, MCP; subtree totals sum only rows whose `parent_id` is not in the selected set; planner excludes `ARCHIVED` unless the filter mentions `status`. ADR-062 follow-up recorded. | Sonnet | M | — | Tests: Slack search numbers equal `runQuery` for the same budget; Overview and Budgets show the same pace index; subtree totals on nested matches equal real spend; `/pacing` excludes archived |
| **W4-3** | **Envelope-currency spend and heatmap gap** (T-6, T-7). Spend-through sums `spend_fact.amount` where `currency = envelope.currency` and converts only the remainder; heatmap keeps a `∅` row/column and prints "N more rows: X" from `totals − Σmargins`. | Sonnet | M | — | Tests: End dialog amount equals Σ amount in envelope currency; heatmap cells + margins + gap == total |
| **W4-4** | **Display and date nits** (T-13, T-14, T-15, T-16, T-17). Workspace "today" helper (UTC today, documented, single place); `daysLeft = end − today`; Explorer surfaces `cacheVersion < dataVersion` as a "refreshing" badge; "—" for missing budget; planner tie-break `approved_at DESC, version_no DESC`. | Haiku | S | — | One test each |
| **D-1** | **Decision needed (T-12)**: closure "budget" basis — keep live leaves and label it, or switch new closures to holdings (ADR-059). | Human | — | — | ADR recorded; Sonnet implements (S) |

**Fable review gate 4**: run the audit's "numeric invariants without a test" table and confirm each row now has a test.

---

## Wave 5 — Observability, sessions, docs, structure

| ID | Item | Model | Size | Deps | Done when |
|---|---|---|---|---|---|
| **W5-1** | **pino in the API** (M-3). `nestjs-pino` (MIT) with request-scoped `requestId`, `workspaceId`, `actorId`; `X-Request-Id` on every response and in error bodies; `redact` for cookie/authorization; readiness `GET /ready` running `SELECT 1` on the app role; worker health only on `/health`. | Sonnet | M | W3-2 | Test: a 500 response carries the same `requestId` as the log line; `/ready` fails when the DB is down |
| **W5-2** | **Env schemas** (M-5). `packages/domain/src/env/{api,worker,mcp}.ts` zod schemas parsed at boot; root `.env.example` listing every key with a comment; `local-runner`/`bootstrap` stop defaulting URLs to `""`. | Haiku | S | — | Boot with a missing required key fails with the key's name |
| **W5-3** | **Session and refresh-token store** (S-11, S-12). `session(jti, user_id, expires_at, revoked_at)` and `oauth_refresh(jti, client, user_id, chain_started_at, revoked_at)`; logout and "sign out everywhere" revoke; refresh rotates and rejects reuse; codes marked used; absolute chain lifetime 90 days; `__Host-` cookie. | Sonnet | M | W3-2 (filter) | Tests: logout invalidates the cookie server-side; refresh reuse → 400 and chain revoked; code replay → 400 |
| **W5-4** | **Per-service service accounts** (S-13). Human creates `budgetos-runtime-{app,slack,worker,mcp,migrate}` with `secretAccessor` only on each service's secrets; agent updates `deploy.yml` and ADR-065. | Haiku (+ human) | S | human | Deploy green; MCP SA cannot read `budgetos-app-database-url` (checked with `gcloud secrets get-iam-policy`) |
| **W5-5** | **Docs truth** (M-4). Renumber ADR `0030-planner-projection-measures` → 0068, `0034-manual-result-entry` → 0069, `0065-slack-toolset` → 0070 and fix citations; regenerate `docs/adr/README.md`; AGENTS §3 commands to match `package.json`; `exports.md`, `TASKS_STATUS` T-008/S-015 to reflect ADR-065 reality; READMEs for each app/package (five lines each). | Haiku | S | — | `grep -rn "ADR-030\|ADR-034\|ADR-065"` resolves unambiguously |
| **W5-6** | **SQL back into `@budget/db`, break api→workers** (M-8, M-9, M-10). Repository functions for the outbox poll, purge, retention, pacing, overview, lifecycle SQL; new `packages/shared` (or grow `@budget/db`) for `ObjectStore`, `loadRegistry`, `FxCache`, Slack blocks, `money`/`pct`/`esc`; `apps/api` drops `@budget/workers`. | Sonnet | L | W1-2, W2-3 | `grep -rn '\$queryRaw\|\$executeRaw' apps/ --include=*.ts \| grep -v test` is empty; `apps/api/package.json` has no `@budget/workers` |
| **W5-7** | **Slack identity pin + replay cache** (S-14, S-15). `app_user.slack_user_id` set on first match, mismatch refused with an ephemeral message; `(timestamp, signature)` cache for 300 s. | Sonnet | S | — | Tests: changed Slack email for a pinned user → refused; replayed request → 401 |
| **W5-8** | **Alerting** (M-7). Terraform `google_monitoring_alert_policy` on log match `"local worker run failed"`, on `outbox` backlog (log-based metric emitted by the worker each pass), and on Cloud SQL backup failure; notification channel = owner email. | Sonnet | S | W0-2 | Policies apply; a forced worker failure pages |
| **W5-9** | **Web unit tests for the big components** (M-11). `vitest.config.mjs` include `*.test.{ts,tsx}`; Testing Library tests for `structure-dialog`, `mapping-wizard`, `shell` state machines. | Sonnet | M | — | Three new test files run in CI |
| **D-2** | **Decision needed**: Memorystore vs the Postgres preview store from W1-5 as the long-term cache for `/query` results and MCP rate limits (per-instance today). | Human | — | — | ADR; Sonnet implements if Memorystore (S) |
| **D-3** | **Decision needed**: whether to deploy the Pub/Sub publisher/push path (spec §19, S-015) or formally adopt the polling worker as the production design (then I-10/I-11 are closed as "not deployed" and ADR-010 is amended). | Human | — | — | ADR |

**Fable review gate 5 (final)**: full re-run of the audit checklist against `main`; confirm every S/T/I/M/B item is fixed, consciously deferred (with the ADR), or a human decision; sign-off note appended to `STACK_AUDIT_2026-10-04.md`.

---

## Totals

| Model | Items | Sizes |
|---|---|---|
| Haiku | 10 | 9 S, 1 S+human |
| Sonnet | 25 | 4 S, 18 M, 2 L, 1 M+human |
| Opus | 5 | W1-1 (L), W3-1 (M), W3-2 (L), W3-5 (M), W3-8 (M) |
| Fable | 6 review gates | — |
| Human | 3 decisions, 3 console tasks (W0-2 describe, W5-4 SAs, GitHub environment + branch protection) | — |

Parallelism: Wave 0 (4 worktrees) → Wave 1 (5) → Waves 2 and 3 can overlap (8 + 9) → Wave 4 (4) → Wave 5 (9). Critical path: W0-1 → W1-1 → W4-1, and W0-1 → W1-2 → W2-3 → W5-6.

## Branch and PR conventions for this plan

- Commit trailers name the model that wrote the commit (`Co-Authored-By: Claude Opus 5.5 …`, `… Haiku 4.5 …`, `… Fable 5.1 …`), matching the repository's existing history; the orchestrator does not rewrite them.

- Branch `fix/W1-2-worker-reliability`, commits `W1-2: …`, PR title `W1-2 — Production worker reliability (audit I-1, I-2, I-7, M-7)`.
- Every PR cites its audit IDs under `## Task` and closes them in `STACK_AUDIT_2026-10-04.md` §8 (status column) in the same PR.
- A PR that changes a decision carries its ADR; the audit lists which items need one: W1-1, W2-6, W3-1, W3-7, W4-2, D-1, D-2, D-3.
