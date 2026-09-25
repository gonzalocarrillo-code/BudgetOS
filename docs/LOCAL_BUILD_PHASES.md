# Local build phases

Plan v0.5 and spec v0.5, reviewed 2026-09-23 against this checkout.

This file is the order a Cursor agent follows to build Budget OS on a laptop, using the same code that later runs on GCP. It does not add product scope. Every task id below is copied from spec §22. Phase 2 and Phase 3 of the plan have no tasks in §22; they are listed at the end so they are not started early.

How to run one phase: open a new Cursor chat and paste the prompt at the bottom of that phase. One task per chat. When the gate passes, set that row to `done` or leave the named clause `blocked` in `docs/TASKS_STATUS.md`.

## What is already true

The checkout contains `AGENTS.md`, `BUDGET_OS_MASTER_PLAN.md`, and `BUDGET_OS_BUILD_SPEC.md`. There is no `package.json`, no `apps/`, no `packages/`, no Terraform, no tests, and no `docs/adr/`.

Spec §1, plan Appendix D, and the old `AGENTS.md` reading list name the plan and spec under `docs/`. They are at the repo root. Agents must read the root paths until a task moves them. Do not fork the documents.

## Review findings that change the order

These are contradictions in the kit. The assumption under each one is what agents implement. Each assumption is restated in the PR that first relies on it.

1. **Golden seed cannot run where §22 places it.** Spec §21 says `golden.ts` calls commands and never inserts versions directly. The §22 sentence places T-006 before T-010 (the commands). **Assumption:** run T-006 in phase 9, after T-010 and T-011. The first seed covers workspaces, the default registry, envelopes, versions, approvals, and audit events. Later tasks add their own seed rows, which `AGENTS.md` already requires. T-007 runs before that seed, on SQL fixtures inside the planner tests.

2. **Spikes cannot use the database golden in week 1.** Plan epic 0.7 / 0.8 and T-026a / T-026b say "against the large golden". The large generator is `scripts/load-test.ts` scaling `golden.ts` (§21), and that seed cannot exist before the commands. The decision log already names Glide Data Grid and SVAR MIT core; T-026a / T-026b still require a measured ADR. **Assumption:** spike benches use 100k in-memory grid rows and 5k in-memory bars generated in `packages/grid/bench` and `packages/timeline/bench`. The ADR states that the database-scale proof is T-034, not the spike. Do not skip the spike because the decision log already picked the libraries. Spec §23.2 still allows a vis-timeline fallback if the SVAR core cannot render target lanes and the marker overlay.

3. **`pnpm dev` is two different commands.** `AGENTS.md` says compose + migrate + seed + api + web. Spec §2's script is `"dev": "turbo run dev --parallel"`. Spec code wins. `pnpm test:e2e` and `pnpm db:seed --size` appear in `AGENTS.md` and not in the spec script block. **Assumption:** T-001 copies the spec script block. Bringing Postgres up is `docker compose up -d` from the spec compose file, then `pnpm db:migrate` and `pnpm db:seed` once those scripts exist. Do not invent a third dev script in T-001.

4. **Two features are both called timeline.** T-012 is the decision timeline and `as_of` query (plan §8.3, spec §9.4, route `GET /envelopes/:id/timeline`). T-037 is the Gantt (plan §4.11, spec §23, route `GET /workspaces/:ws/timeline`). They stay separate packages, endpoints, and tests.

5. **Worker names.** Plan §5.1 and the architecture diagram list `alert-worker`. Spec §19 and `AGENTS.md` assign Slack alerts, approval messages, and mentions to `notify-worker`, and list `outbox-publisher` separately. Spec wins. Do not create `alert-worker`.

6. **Frame-rate numbers disagree.** Plan epic 0.7 says 60 fps at 100k envelopes. T-026c's done-when says ≥ 55 fps p50. The PR gate is 55 fps p50. The epic goal stays unmet until a later bench records 60 fps. Do not edit the plan number inside the spike PR.

7. **Epic 0.4 is larger than T-005.** The goal says a new dimension appears as a filter, group-by, search qualifier, and MCP parameter within 10 seconds. Search is T-020. MCP is T-025. **Assumption:** T-005 asserts registry CRUD, default seed, icon rules, and rejection of an envelope tuple the registry does not allow. T-020 and T-025 re-assert the search and MCP clauses. T-005 is not `done` until its own clause is green; it is not held for MCP.

8. **Some done-when lines need GCP or CI.** A laptop cannot honestly pass them. They stay `blocked` on the task row. Local clauses can land in the same PR. Do not stub the cloud call and mark the cloud clause done.

   | Task | Local clause | Cloud or CI clause |
   |---|---|---|
   | T-008 | none | `/healthz` behind IAP in GCP dev |
   | T-016 | duplicate delivery hits `processed_event` once | message on a real Pub/Sub topic |
   | T-017 | ≥ 99% match of golden via the CSV connector; rejected-rows report in a GCS emulator | live Snowflake, Sheets, BigQuery reads |
   | T-020 | index lag < 5 s on the small golden | p95 < 150 ms at 1M docs, in the T-034 load job |
   | T-023 | CSV and XLSX respect the filter | Sheets push; BigQuery views queryable |
   | T-024 | locked envelope returns 423 | BigQuery closure table written |
   | T-025 | golden numbers; CI guard rejects a mutating tool | Cloud Run behind IAP with per-user OAuth |
   | T-034 | — | Appendix C at 100k leaves / 30M facts, CI load job |
   | T-035 | — | pilot month, pen test, staging → prod |

9. **Auth has no local bypass in the spec.** T-009's done-when is the permission-matrix test. T-026's done-when is navigation with auth. **Assumption:** tests mint a JWT whose claims match what spec §16's `auth.ts` validates (Identity Platform shaped token), using a test JWKS. There is no `SKIP_AUTH`. Live Google Workspace SSO is phase 20. Groups sync is tested with a fixture payload; live Google Groups stays blocked on plan §16 question 6.

10. **T-024 writes to BigQuery inside the close command** (spec §15). The spec does not define a sink interface. **Assumption, ADR required in the T-024 PR:** a `ClosureSink` with a BigQuery implementation as the production class. The 423 test uses a recording fake. The fake is not a second system of record. The GCP phase replaces the proof by querying the real table.

11. **Open questions that block live work, not local command tests.** From plan §16: pilot client (1), FX source (2), Snowflake views and SLA (4), e-signature vs uploaded evidence (5), Google Groups vs manual assignment (6), audit retention (8), conversion definitions (9), who approves manual actuals (15). Spec already defaults `fiscalYearStartMonth` to 1 and the manual-entry policy to one approval by `finance` or `budget_owner` in scope (§26). Use those defaults. Do not invent an FX provider, a Snowflake view name, or a pilot workspace.

12. **Phase 1 search is Postgres** (`pg_trgm` + FTS) behind `SearchProvider`. Meilisearch is the named swap target, not a Phase 1 process. Do not add it to compose.

13. **Spec §22 is filed after §27** in the spec file. The task table is near the end. Section numbers in the table still point at the earlier sections.

## Local runtime

Spec §2 compose is the local runtime:

- `postgres:16`, user `budget`, password `budget`, database `budget`, port 5432, extensions `pgcrypto`, `ltree`, `pg_trgm`, `btree_gin` created by migration `0001_roles`.
- `redis:7`, port 6379, used for idempotency keys (spec §17, 24h).

Roles: migrations as `budget_owner`; application as `budget_app` with `NOBYPASSRLS`. Tests that claim RLS must connect as `budget_app`.

T-017 is the only task whose done-when names an emulator ("GCS emulator"). The spec does not name an image. The T-017 PR records the image in an ADR before adding it to compose. No other emulator is added in earlier phases.

GCP shape that stays in the code from the first commit, without being deployed:

- one NestJS app, one worker entry per spec §19 process, stateless
- transactional outbox, not in-process side effects
- `workspace_id` and RLS on every tenant table
- Terraform modules from spec §20 written in phase 20, not before
- secrets from the environment, `.env.example` placeholders only

## Definition of a green phase

A phase is green when every task in it is `done`, or `done` for the local clause and `blocked` only for the cloud clause named above, and this command is green from the repo root:

```sh
pnpm typecheck && pnpm lint && pnpm test && pnpm license-check
```

Add `pnpm bench` when the task touches `packages/grid`, `packages/timeline`, or `packages/query-planner`.
Add `pnpm test:acceptance` when the task's done-when cites an epic `/goal`.
Add `pnpm test:e2e` when the task's done-when cites Playwright. That script is not in spec §2; the T-026 PR adds it, because T-026 is the first task whose done-when is Playwright. Until that PR, do not fail a phase for a missing `test:e2e` script.

UI tasks: exercise the flow in a browser (click, type, reload), not a single screenshot. `AGENTS.md` and the user rule require this. If the browser tool is unavailable, say so and run the Playwright spec instead.

## Phase 1 — Scaffold

**Tasks:** T-001
**Depends on:** nothing
**Spec:** §1, §2

Create the repo layout in spec §1, pinned versions in §2, root scripts copied from the spec code block, `docker-compose.yml` copied from the spec code block, empty package skeletons that typecheck, and CI job `lint-typecheck` only. Node 22 (`.nvmrc` = `22`), pnpm 9. Do not create tables, routes, or Terraform.

**Gate:** `pnpm install && pnpm typecheck` exits 0.

```
Read AGENTS.md and docs/LOCAL_BUILD_PHASES.md phase 1. Do task T-001 from BUDGET_OS_BUILD_SPEC.md §22. Copy spec §2 scripts and docker-compose. Write the typecheck gate first. Stop after T-001. Update docs/TASKS_STATUS.md.
```

## Phase 2 — Database, domain, tenancy

**Tasks:** T-002, then T-003, then T-004. Three PRs.
**Depends on:** phase 1
**Spec:** §3, §4, §5, §9.1, §12.2

T-002: Prisma schema from spec §3.2 and SQL migrations `0001_roles`, `0002_platform`, `0003_functions` from §3.3, plus the tables §22 names (`eligible_approver`, `effective_target`, `subscription`, `notification`, `processed_event`, `bulk_change`). Fresh database. Application role cannot read another workspace's envelope.

T-003: `@budget/domain` errors, filter AST, query, permissions, approvals, search parser. Every zod schema round-trips. `parseSearch` table test has 20 cases, taken from spec §12.2, not invented.

T-004: `withTenant`, `audit`, `outbox`, `bumpDataVersion`, fact row types from §3.4 and §4. Two concurrent transactions must not see each other's `SET LOCAL` tenant.

**Gate:** the three done-when lines, then `pnpm typecheck && pnpm lint && pnpm test && pnpm license-check`.

```
Read AGENTS.md and docs/LOCAL_BUILD_PHASES.md phase 2. Do the next pending task among T-002, T-003, T-004. Spec code in §3–§5 is the starting point. Write that task's done-when test first. Stop after one task. Update docs/TASKS_STATUS.md.
```

## Phase 3 — Registry

**Tasks:** T-005
**Depends on:** phase 2
**Spec:** §8, `packages/db/seed/defaults.registry.ts`

Registry commands from spec §8. Default registry seed. Icon is `lucide:<name>` or `asset:<gcsObject>` after SVG sanitization. This phase does not add a GCS emulator; the asset upload test can store the object through the repository interface the spec's `POST /assets` uses and assert the sanitizer. If that requires an object store the spec does not name, stop and write the ADR instead of picking a server.

Do not assert search suggest or MCP in this task (finding 7).

**Gate:** acceptance test for registry create, nested values, hierarchy template, default seed, and rejection of an unknown dimension tuple. `pnpm test:acceptance` includes `epic-0.4` for those clauses only.

```
Read AGENTS.md and docs/LOCAL_BUILD_PHASES.md phase 3. Do T-005 only. Epic 0.4 search and MCP clauses are out of scope until T-020 and T-025. Write the acceptance test first. Stop after T-005. Update docs/TASKS_STATUS.md.
```

## Phase 4 — Query planner

**Tasks:** T-007
**Depends on:** phase 2. Does not wait for T-006.
**Spec:** §6

Implement `compile-filter` and `compile-query` from the spec code. Tests in §6.3, including property tests. Fixtures are SQL inserted by the test, with totals asserted in the test. Do not insert envelope versions by bypassing commands; these fixtures are fact and envelope rows the planner reads, and the test file is the only place that inserts them directly. The golden seed, which must use commands, is phase 9. After phase 9, add the golden assertion cases to this suite in the T-006 PR.

**Gate:** planner test suite green, including property tests. `pnpm bench` for the planner.

```
Read AGENTS.md and docs/LOCAL_BUILD_PHASES.md phase 4. Do T-007. Use spec §6 code. Tests use SQL fixtures, not golden.ts. Write the suite first. Stop after T-007. Update docs/TASKS_STATUS.md.
```

## Phase 5 — Grid and timeline spikes

**Tasks:** T-026a and T-026b. Two PRs. May start after phase 1, in parallel with phases 2–4.
**Depends on:** T-001
**Spec:** plan §11.9, spec §18.2, §23.2

Measure Glide Data Grid against a TanStack-only build (T-026a) and `@svar-ui/react-gantt` against vis-timeline and a custom canvas (T-026b). Data is in-memory, 100k rows and 5k bars (finding 2). Write `docs/adr/0002-grid-core.md` and `docs/adr/0003-timeline-core.md`. Record the numbers. Reflect the decision in each package README. No `@svar/*` PRO package. `pnpm license-check` green.

The first of these PRs also adds `docs/adr/0000-template.md` with four headings: Status, Context, Decision, Consequences. The spec names that file and does not include its body.

**Gate:** both ADRs merged, bench numbers committed, marker overlay and a target lane demonstrated for the timeline spike.

```
Read AGENTS.md and docs/LOCAL_BUILD_PHASES.md phase 5. Do the next pending task among T-026a and T-026b. Benches use in-memory rows, not the database golden. Write the ADR with the measured numbers. Stop after one spike. Update docs/TASKS_STATUS.md.
```

## Phase 6 — Grid package

**Tasks:** T-026c
**Depends on:** T-026a
**Spec:** §18.2

`RowSource`, page cache, path / money / pace / status / chips renderers, editors, paste calling `onPaste`, pinned totals, benchmark, baseline file. Storybook story per cell kind.

**Gate:** bench ≥ 55 fps p50 at 100k in-memory rows. `pnpm license-check` green. `pnpm bench` green. Do not treat 55 fps as meeting the plan's 60 fps epic goal.

```
Read AGENTS.md and docs/LOCAL_BUILD_PHASES.md phase 6. Do T-026c from spec §18.2. Gate is ≥ 55 fps p50 at 100k in-memory rows. Stop after T-026c. Update docs/TASKS_STATUS.md.
```

## Phase 7 — Auth and permissions

**Tasks:** T-009
**Depends on:** phase 2
**Spec:** §4, §5.4, plan §7

Identity Platform JWT validation, tenant interceptor, roles, scope guard, groups sync endpoint. Permission matrix covers every role in plan §7.1 and every action in spec §5.4. Tokens in tests are test JWTs (finding 9). Separation of duties: a user cannot approve their own request. Scope filters use the same `FilterGroup` AST as queries.

**Gate:** permission-matrix test green.

```
Read AGENTS.md and docs/LOCAL_BUILD_PHASES.md phase 7. Do T-009. Permission matrix for every role × action, using test JWTs. No auth bypass. Live Google SSO stays blocked. Stop after T-009. Update docs/TASKS_STATUS.md.
```

## Phase 8 — Envelopes and approvals

**Tasks:** T-010, then T-011. Two PRs.
**Depends on:** phase 7
**Spec:** §7.1, §7.2, §7.3, §9

T-010: create, draft version, phasing, restore, metadata edit with `rowVersion`. Conflict returns 409 with `currentVersionId`. Every write asserts one `audit_event` and one `outbox` row. No in-place update of an approved amount.

T-011: policies, matcher, submit, decide, escalate, external evidence. Cap trigger test: children cannot be approved above the parent. Epic 1.3 acceptance test quotes the `/goal` sentence.

**Gate:** both done-when lines, plus audit and outbox assertions.

```
Read AGENTS.md and docs/LOCAL_BUILD_PHASES.md phase 8. Do the next pending task among T-010 and T-011. Spec §7 and §9 code is the starting point. Assert audit_event and outbox. Stop after one task. Update docs/TASKS_STATUS.md.
```

## Phase 9 — Golden dataset

**Tasks:** T-006
**Depends on:** T-005, T-010, T-011
**Spec:** §21

Generator calls the real commands. Asserted totals cover what those commands can create: registry, envelope tree, approved versions, phasing. Seed completes in under 60 seconds. Commit `golden.assertions.ts`. In this same PR, point the planner tests at those assertions for the totals that exist. Do not seed threads, facts, targets, or closures by raw insert.

**Gate:** `pnpm db:seed` under 60 seconds on local Postgres 16; assertions file committed; planner tests that read those totals are green.

```
Read AGENTS.md and docs/LOCAL_BUILD_PHASES.md phase 9. Do T-006. The seed must call envelope and approval commands, not insert versions. Scope is only entities whose commands exist. Stop after T-006. Update docs/TASKS_STATUS.md.
```

## Phase 10 — Point in time

**Tasks:** T-012
**Depends on:** phase 9
**Spec:** §9.4

Decision timeline from audit rows, and `as_of` on the budget read. Replay of the golden history matches `golden.assertions.ts`. This is not the Gantt.

**Gate:** replay test green.

```
Read AGENTS.md and docs/LOCAL_BUILD_PHASES.md phase 10. Do T-012 (decision timeline and as_of), not T-037. Replay golden history against golden.assertions.ts. Stop after T-012. Update docs/TASKS_STATUS.md.
```

## Phase 11 — Bulk edit, lineage, targets

**Tasks:** T-013, T-014, T-015. Three PRs. Each extends the golden seed with its own rows.
**Depends on:** phase 8 for T-013 and T-014; phase 4 and phase 8 for T-015. T-015's roll-up assertion needs facts in the test fixture if the golden seed does not have `kpi_fact` yet.
**Spec:** §7.4, §7.5, §10, §6.2

T-013: bulk preview and commit, paste, CSV round-trip. 10k rows in under 10 seconds.
T-014: move, split, merge with lineage. Cap is re-validated.
T-015: targets, metric library, `effective_target`, planner `targets[]`. CPA at every roll-up level equals spend divided by conversions. Money stays `Decimal` / `NUMERIC(18,2)`.

**Gate:** the three done-when lines. `pnpm bench` on T-015.

```
Read AGENTS.md and docs/LOCAL_BUILD_PHASES.md phase 11. Do the next pending task among T-013, T-014, T-015. Extend the golden seed only with rows this task's commands can write. Stop after one task. Update docs/TASKS_STATUS.md.
```

## Phase 12 — Outbox, ingest, pacing, threads, search, notify, rollup

**Tasks, in order:** T-016, T-017, T-018, T-019, T-020, T-021, T-022. Seven PRs.
**Depends on:** phases 4 and 11, and T-004. T-018 also needs T-017. T-021 needs T-016, T-018, and T-019. T-022 needs T-007 and T-016.
**Spec:** §19, §14, §11, §13, §12, §6

T-016: publisher and `processed_event`. Duplicate delivery test. Publishing to a real topic stays `blocked` until phase 20. The handler under test is the spec handler, called twice with the same `outbox.id`.

T-017: connector interface and pipeline from spec §14. Local proof is the CSV connector against golden files, ≥ 99% match, rejected rows written through a GCS emulator. ADR names the emulator image before compose changes. Snowflake, Sheets, and BigQuery `read()` implementations follow the spec and are not called in this gate. `suggest-mapping` goes through `@budget/ai` only; without an OpenAI key that route is unexercised and the PR says so. Do not stub OpenAI inside the route.

T-018: pacing evaluator and alerts API. Consecutive-days test. No duplicate open alert for the same envelope and rule. Invoke the job function directly. Cloud Scheduler stays phase 20.

T-019: threads, comments, mentions, tags, subscriptions. A blocking thread blocks submit. A mention creates a notification row.

T-020: search indexer and search/suggest API. Index lag under 5 seconds on the small golden. The 1M-document p95 stays on T-034.

T-021: `notify-worker` Slack Block Kit snapshots for alert, approval, and mention. No live Slack call in the test.

T-022: `rollup-worker` and the planner tree read of `rollup_cache`. Tree totals equal pivot totals on the golden seed.

**Gate:** each done-when local clause. Cloud clauses remain `blocked` on the status row. The task is not marked `done` while a cloud clause is open; status stays `blocked` with the local tests green, and the phase can still advance.

```
Read AGENTS.md and docs/LOCAL_BUILD_PHASES.md phase 12. Do the next pending task in the phase 12 order. Implement only that task's local clause. Leave the named cloud clause blocked. Stop after one task. Update docs/TASKS_STATUS.md.
```

## Phase 13 — Exports and closures

**Tasks:** T-023, then T-024.
**Depends on:** phase 4; T-024 also needs T-011
**Spec:** §17 exports, §15, §20 for the view SQL

T-023: CSV and XLSX respect the current filter. Terraform view SQL is written and `terraform validate`d if the Terraform module exists; if phase 20 has not created `infra/` yet, commit the SQL under `infra/modules/bigquery/` as the spec module and validate formatting only. "Views queryable" stays `blocked`. Sheets push stays `blocked`.

T-024: 423 on a locked envelope. `ClosureSink` ADR (finding 10). BigQuery streaming insert stays the production class and stays `blocked` for proof.

**Gate:** filter export test; 423 test. Cloud clauses `blocked`.

```
Read AGENTS.md and docs/LOCAL_BUILD_PHASES.md phase 13. Do the next pending task among T-023 and T-024. Local clause only. BigQuery proof stays blocked. Stop after one task. Update docs/TASKS_STATUS.md.
```

## Phase 14 — Read-only MCP

**Tasks:** T-025
**Depends on:** T-007, T-012, T-020
**Spec:** §16

Tools imported only from `queries/`, never `commands/`. Guard test fails CI if that import appears. Each tool returns the golden numbers for the data that exists. Audit row with `actor_type = 'mcp'`. No mutating tool. IAP hosting stays phase 20.

**Gate:** tool tests green; guard test green.

```
Read AGENTS.md and docs/LOCAL_BUILD_PHASES.md phase 14. Do T-025 from spec §16. Read-only guard test and golden numbers. Stop after T-025. Update docs/TASKS_STATUS.md.
```

## Phase 15 — Web shell

**Tasks:** T-026
**Depends on:** T-009, T-025
**Spec:** §18.1

TanStack Router file routes from §18.1, OpenAPI client generated into `apps/web/src/lib/api.ts`, shell with nav, workspace switcher, and search entry. Design tokens: if `tokens.css` is not in the repo, use the shadcn defaults and write in the PR that the design-team file is absent. Do not invent a visual language.

Playwright visits every route with a test JWT from phase 7. Add the `pnpm test:e2e` script in this PR.

**Gate:** `pnpm test:e2e` navigates every route in §18.1. Then verify the same routes in the browser if a browser tool is available.

```
Read AGENTS.md and docs/LOCAL_BUILD_PHASES.md phase 15. Do T-026. Playwright must open every §18.1 route with a test JWT. No auth bypass. Stop after T-026. Update docs/TASKS_STATUS.md.
```

## Phase 16 — Explorer and operations UI

**Tasks, in order:** T-027, T-028, T-029, T-030, T-031, T-031b, T-032, T-033.

Plan 0.6 additions (product owner): T-029 puts the Decision Timeline in the envelope drawer as a History tab that every budget always has; T-030 adds the Comments tab there and emoji reactions per account (new table and routes, with an ADR); T-031's icon picker is the icon library for custom granularities; T-031b is new: envelope structure from the UI (add child, move under, split, merge) on the existing T-014 API.
**Depends on:** phase 15, plus the API task named on each row in `TASKS_STATUS.md`
**Spec:** §18.2, §18.3, §18.4, §18.5

Each done-when is a Playwright spec. Server returns totals, grouping, and sort; the grid does not compute them. Paste opens the bulk preview (T-013), it does not write cells directly. Every disabled control has a `reason`. Every tour target has `data-tour`.

T-033: overview renders in under 1.5 seconds on the small golden dataset.

**Gate:** that task's Playwright spec, then the same clicks in the browser.

```
Read AGENTS.md and docs/LOCAL_BUILD_PHASES.md phase 16. Do the next pending task from T-027 through T-033. Playwright for the done-when, then the same flow in the browser. Stop after one task. Update docs/TASKS_STATUS.md.
```

## Phase 17 — Scale suite, first run

**Tasks:** T-034
**Depends on:** T-022, T-027, T-033
**Spec:** §21, plan Appendix C

`scripts/load-test.ts` scales the golden generator. CI job, not a laptop default. Targets from Appendix C: grid query p95 < 400 ms, search p95 < 150 ms at the indexed corpus this job builds, 10k-row bulk commit < 10 s, roll-up and search lag p95 < 5 s. The job's envelope count is the spec's 100k leaves. If the runner cannot hold 30M facts, the job fails and stays failed. Do not shrink the dataset to go green.

This run happens before T-036–T-041 because that is the §22 sentence. Phase 19 runs it again.

**Gate:** CI load job green at the spec scale, or an explicit red with the runner limit recorded. A local green on a smaller sample does not count.

```
Read AGENTS.md and docs/LOCAL_BUILD_PHASES.md phase 17. Do T-034. Appendix C targets at spec scale in CI. Do not shrink the dataset. Stop after T-034. Update docs/TASKS_STATUS.md.
```

## Phase 18 — Naming, Gantt, experiments, manual entry, home

**Tasks, in order:** T-036, T-037, T-038, T-039, T-040, T-041.
**Depends on:** phase 17, plus the predecessors on each status row
**Spec:** §24, §23, §25, §26, §27, §12

T-036: migration `0004_naming`, `renderTemplate`, preview of 5 samples, matching order from §24.3 replaces ingest step 5, `match_method` set on every matched golden fact.

T-037: `GET /timeline`, `@budget/timeline` adapter, `view=timeline` in Explorer. 5k bars under 500 ms p95. As-of redraw matches `/query`. No `@svar/*` PRO import. Read-only. Drag-edit is plan epic 2.5 and is out of scope.

T-038: migration `0005`, experiment commands, read-out, timeline lane, search qualifier. Weighted CPA test vs control equals the planner. Conclude requires a decision and posts a thread comment.

T-039: migration `0006`, manual entry batches, policy `entity_type='manual_entry'`, approve writes facts with `source_system='manual'`. Rejected batch returns to draft. Submit button disabled state includes a `reason`.

T-040: `GET /me/home`, driver.js tours for planner, approver, finance, and data admin, workspace template, demo purge, eslint rule `budget/no-bare-disabled`. New workspace from the template is usable in under 60 seconds.

T-041: settings pages indexed as `entity_type='setting'`. A setting name in ⌘K opens that admin page.

Each task extends the golden seed. UI tasks get a browser pass after Playwright.

**Gate:** that task's §22 done-when.

```
Read AGENTS.md and docs/LOCAL_BUILD_PHASES.md phase 18. Do the next pending task from T-036 through T-041. Keep the Gantt separate from the decision timeline. Stop after one task. Update docs/TASKS_STATUS.md.
```

## Phase 19 — Scale suite, again

**Tasks:** none new. Re-run T-034.
**Depends on:** phase 18

Naming, experiments, manual facts, and timeline queries now exist. Appendix C is re-run on the same CI job. A regression fails the phase. Do not add a task id.

**Gate:** the phase 17 job is green on the post-phase-18 code.

```
Read AGENTS.md and docs/LOCAL_BUILD_PHASES.md phase 19. Re-run the T-034 load job on current main. Do not add a task and do not change the dataset size. Record the result in docs/TASKS_STATUS.md under T-034.
```

## Phase 20 — GCP dev

**Tasks:** T-008, then the blocked clauses of T-016, T-017, T-023, T-024, T-025.
**Depends on:** phase 1 for T-008. The other clauses depend on their own tasks having landed.
**Spec:** §20

Do not start until a human has a GCP organization, three projects (`dev`, `staging`, `prod`), a Terraform state bucket, and Workload Identity Federation for GitHub. Those are not in the repo and must not be invented.

T-008: Terraform `dev` from spec §20 and a hello `budget-api` revision. **Gate:** `/healthz` returns 200 behind IAP. Measure wall time; epic 0.2's goal is a deploy through CI in under 10 minutes.

Then, still in `dev` only:

- T-016: one real Pub/Sub delivery plus the existing duplicate test.
- T-017: one BigQuery read against a dataset the human names. Snowflake and Sheets stay blocked on plan §16.4.
- T-023: `SELECT` from each curated view.
- T-024: one closure row in the BigQuery table.
- T-025: MCP URL behind IAP. Per-user OAuth sees only that user's RLS scope.

`staging` and `prod` are not created in this phase beyond the Terraform roots existing. Prod promotion is T-035.

```
Read AGENTS.md and docs/LOCAL_BUILD_PHASES.md phase 20. Do not start unless GCP dev credentials and a state bucket are present in the environment. Do T-008 first. Gate is /healthz behind IAP. Stop after T-008 unless the user names the next blocked clause. Update docs/TASKS_STATUS.md.
```

## Phase 21 — Pilot

**Tasks:** T-035
**Depends on:** phase 19 green, phase 20 green, and answers to plan §16 questions 1, 2, 4, 5, 6, 8, 9, and 15.

Runbooks in `docs/runbooks/`. SLO alerts. Pen-test fixes. Staging to prod with the manual approval environment in spec §20. Phase 1 exit is the plan's sentence: every Phase 1 `/goal` green, and every must-have row in Appendix A mapped to a passing acceptance test.

An agent does not close this phase. A human confirms the pilot month and the pen test.

```
Read AGENTS.md and docs/LOCAL_BUILD_PHASES.md phase 21. Do not start T-035 until phases 19 and 20 are green and plan §16 questions 1, 2, 4, 5, 6, 8, 9, and 15 have written answers. Otherwise stop and list which answers are missing.
```

## Not started

Spec §22, last paragraph: Phase 2 tasks are written in follow-up ADRs after Phase 1 exit. No §22 rows exist for them. Do not implement any of the following while a phase above is unfinished.

| Plan epic | Goal, one line | Starts |
|---|---|---|
| 2.1 | Scenarios, compare up to 3, promote one to draft | after Phase 1 exit |
| 2.2 | Per-user notification preferences, digests, Slack approve/reject | after Phase 1 exit |
| 2.3 | Auto-approve, carry-forward, scheduled exports, audited as system | after Phase 1 exit |
| 2.4 | Copilot over MCP tools, every number links to a query | after Phase 1 exit |
| 2.5 | Timeline drag-edit, PDF closure, webhooks, ES/PT | after Phase 1 exit |
| 2.6 | Formula envelopes and target rules | after Phase 1 exit |
| 2.7 | Slack thread mirror, semantic search | after Phase 1 exit |
| 3.1 | Variance model on `f_budget_vs_actual_daily` | after 2 closed quarters |
| 3.2 | Reallocation suggestions through the human approval chain | after 3.1 |

## Prompt for the next session

Paste this as-is. The phase file and the status file decide the task.

```
Read AGENTS.md, then docs/LOCAL_BUILD_PHASES.md, then docs/TASKS_STATUS.md.
Do the single next pending task. Write its done-when test first.
Follow the phase assumptions. Do not start a second task.
Update docs/TASKS_STATUS.md when the gate is green.
```
