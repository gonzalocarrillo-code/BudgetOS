# Task status

Source of truth for scope: `BUDGET_OS_BUILD_SPEC.md` §22 (version 0.5).
Source of truth for order and gates: `docs/LOCAL_BUILD_PHASES.md`.

Repo on 2026-09-26: T-001 through T-007, T-009, T-010, T-011, T-012, T-013, T-014, T-015, T-019, T-022, T-027, T-028, T-029, T-030, T-031, T-031b, T-033, T-036, T-037, T-038, T-039, T-040, T-041, T-026a, T-026b, and T-026c are done. T-016, T-017, T-018, T-020, T-021, T-023, T-024, T-025, T-026 and T-032 are `blocked` on their cloud or load clauses with the local gates green. Later tasks are `pending`.

Bench maintenance (`task/bench-macos`, 2026-09-23, not a §22 task): `pnpm bench` runs on macOS through `CHROME_PATH` or the default Chrome location. turbo runs the grid, timeline and query-planner benches one after another. ADR-002 `## Notes` has the details.

Planner bench maintenance (`task/planner-bench-stable`, 2026-09-23, not a §22 task): the `compileQuery` bench warms up for 200k calls, times 31 batches, and gates the p50 ratio to a planner-shaped calibration loop at 10%. The baseline was re-recorded on an Apple M2, and again after the T-007 fixes (PR #1) merged: the fixed compiler does more work per call, so the ratio moved from 0.6406 to 1.018. ADR-006 has the method and the numbers.

Planner projection performance (`task/planner-projection-perf`, 2026-09-26, not a §22 task): `projected` and the measures derived from it are read once per envelope through a lateral join instead of a scalar subquery copied into every expression that uses it. Flat pages that neither sort nor filter on them read projections after the LIMIT, for the page's rows only. `plannerOptions()` sets `hasProjections`, so a workspace without projection facts never touches `projection_fact`. Results are unchanged. The planner bench gains `executeProjection` and `executeProjectionEmpty`. ADR-030 has the plans and numbers.

Golden seed speed (`task/golden-seed-speed`, 2026-09-26, not a §22 task): the seed logs each phase's seconds. It reads each approval request's frozen chain once, walks it on `decide`'s returned status, and tracks envelope heads in memory instead of reading them back. `withTenant()` sets its four settings in one statement. The golden data and assertions are unchanged. The seed runs 23% fewer statements and 30% fewer transactions; on a fresh database it takes 15.8 s instead of 21.6 s. The rest of the local slowdown is bloated fact indexes in the developer database (REINDEX, or `pnpm db:reset`). ADR-034 has the profile.

Status values: `pending` | `in_progress` | `done` | `blocked`.
A task is `done` only when its §22 "Done when" test is green and the phase gate in `LOCAL_BUILD_PHASES.md` passed. Partial GCP clauses stay `blocked` until that gate passes; do not mark the whole task `done` on the local clause alone when the phase doc says the task is split.

| ID | Phase | Predecessors | Status | Local gate | Still blocked after local gate |
|---|---|---|---|---|---|
| T-001 | 1 | — | done | `pnpm install && pnpm typecheck` | — |
| T-002 | 2 | T-001 | done | `pnpm db:migrate` on fresh Postgres 16; RLS test | — |
| T-003 | 2 | T-001 | done | zod round-trip; `parseSearch` 20 cases | — |
| T-004 | 2 | T-002, T-003 | done | concurrent `SET LOCAL` isolation test | — |
| T-005 | 3 | T-002, T-004 | done | registry acceptance, excluding search and MCP clauses; search qualifier covered by T-020 (suggest test); MCP parameter covered by T-025 (`mcp/src/tools.test.ts`) | — |
| T-007 | 4 | T-002, T-003, T-004 | done | planner suite including property tests, on SQL fixtures | — |
| T-026a | 5 | T-001 | done | bench numbers in ADR-002 | DB golden at 100k leaves is T-034 |
| T-026b | 5 | T-001 | done | 5k-bar bench; target lane + marker overlay; ADR-003 | same |
| T-026c | 6 | T-026a | done | ≥ 55 fps p50 at 100k in-memory rows; storybook; `pnpm license-check` | plan epic 0.7 still says 60 fps; re-measure at T-034 |
| T-009 | 7 | T-002, T-003, T-004 | done | permission matrix, every role × action | live Google SSO and live Google Groups (plan §16.6) |
| T-010 | 8 | T-004, T-009 | done | 409 with `currentVersionId` | — |
| T-011 | 8 | T-010 | done | epic 1.3 acceptance; cap trigger | — |
| T-006 | 9 | T-005, T-010, T-011 | done | `pnpm db:seed` < 60 s; assertions file committed | threads, closures added by later tasks (targets: T-015, facts: T-017) |
| T-012 | 10 | T-006, T-011 | done | replay over golden history matches assertions | — |
| T-013 | 11 | T-010 | done | 10k rows < 10 s | — |
| T-014 | 11 | T-010, T-011 | done | cap re-validation | — |
| T-015 | 11 | T-007, T-010 | done | CPA roll-up = spend / conversions at every level | `POST /workspaces/:ws/targets/import` not built: the connectors exist (T-017), the pipeline has no `target` kind yet; ADR-009 |
| T-016 | 12 | T-004 | blocked | duplicate delivery applies once — green (`apps/workers/src/outbox.test.ts`, ADR-010) | live Pub/Sub topic, Cloud Run services, push auth (GCP phase) |
| T-017 | 12 | T-002, T-005, T-010 | blocked | ≥ 99% match on golden CSV (99.69%) and rejected-rows report in the GCS emulator — green (`seed/golden.test.ts`, `workers/src/ingest`, ADR-011) | live Snowflake, Sheets, BigQuery (plan §16.4; no credentials in spec); Secret Manager; `suggest-mapping` needs `OPENAI_API_KEY` |
| T-018 | 12 | T-015, T-017 | blocked | consecutive-days test; no duplicate open alerts — green (`workers/src/pacing`, golden pacing rows, ADR-012) | Cloud Scheduler 15 min trigger (GCP phase); "unmatched spend > 2 %" default rule waits for a workspace-level alert (ADR-012) |
| T-019 | 12 | T-011 | done | blocking thread blocks submit; mention notifies — green (`modules/threads`, golden threads and tags, ADR-013) | — |
| T-020 | 12 | T-016 | blocked | index lag < 5 s on small golden; suggest API — green (`seed/golden.test.ts`, `modules/search`, ADR-014) | p95 < 150 ms at 1M docs is the T-034 load job |
| T-021 | 12 | T-016, T-018, T-019 | blocked | Slack Block Kit snapshot tests — green (`workers/src/notify`, ADR-015) | live Slack workspace |
| T-022 | 12 | T-007, T-016 | done | tree totals = pivot totals on golden — green (`seed/golden.test.ts` rollup, `workers/src/rollup`, ADR-016) | — |
| T-023 | 13 | T-007 | blocked | CSV/XLSX export respects filter — green (`seed/golden.test.ts` exports, `api/src/modules/exports`, `workers/src/export`); view SQL checked against Postgres (`db/src/bigquery-views.test.ts`), ADR-017 | Sheets push; BigQuery views queryable; `terraform fmt`/`validate` (GCP phase) |
| T-024 | 13 | T-011, T-007 | blocked | locked envelope rejects draft with 423 — green (`api/src/modules/closures`, `seed/golden.test.ts` closures; closed-period ingest rejection in `workers/src/ingest`), `ClosureSink` ADR-018 | BigQuery closure tables written and queried (GCP phase) |
| T-025 | 14 | T-007, T-012, T-020 | blocked | tools return golden numbers; read-only guard test — green (`mcp/src/tools.test.ts` on golden, `import-guard.test.ts` in CI, `readonly.test.ts` for the `budget_mcp` role), ADR-019 | IAP and per-user OAuth on Cloud Run (GCP phase) |
| T-026 | 15 | T-009, T-025 | blocked | Playwright navigates every §18.1 route with a test JWT — green (`pnpm test:e2e`, 25 tests; checked in the browser), ADR-020; tokens from the product screenshots, ADR-021 | Identity Platform sign-in (GCP phase) |
| T-027 | 16 | T-026, T-026c, T-007, T-022 | done | Playwright: filter → URL → reload; inline edit conflict; pivot = tree — green (`web/e2e/explorer.spec.ts`, plus paste → bulk preview and saved views; checked in the browser), ADR-022 | — |
| T-028 | 16 | T-020, T-026 | done | Playwright qualifier autocomplete — green (`web/e2e/search.spec.ts`: key → value → chip → results → deep link; custom dimension qualifier; See all; ⇧Enter to the Explorer; checked in the browser), ADR-023 | — |
| T-029 | 16 | T-011, T-012, T-026 | done | Playwright decide flow — green (`web/e2e/approvals.spec.ts`: two-step chain from each inbox, comments by account, disabled with reason; plan 0.6 History tab in the drawer), ADR-024 | — |
| T-030 | 16 | T-015, T-019, T-026 | done | Playwright mention flow — green (`web/e2e/threads.spec.ts`: @bud → Golden budgetOwner, reactions by account, edit history, comments on approvals and targets, tag chips, target propose → submit); plan 0.6 Comments tab in every drawer, `comment_reaction`, ADR-025 | — |
| T-031 | 16 | T-005, T-026 | done | Playwright add-dimension < 10 s into filters and ⌘K — green (`web/e2e/registry.spec.ts`: icon from the library, `Parent > Child` values, move under with subtree, hierarchy builder, default granularities, metric library); `PATCH /values/:id {parentCode}`, `PATCH /hierarchy-templates/:id`, `GET /assets/icons/:file`, ADR-026 | — |
| T-031b | 16 | T-014, T-027 | done | plan 0.6: Playwright add child, move under and split from the tree / drawer, through preview and approval — green (`web/e2e/structure.spec.ts`: add child → budget owner → approver; move refused over cap then to top level; split auto-approved, source archived); `POST /envelopes/structure/preview` (real command, rolled back), `POST /envelopes/:id/children`, `structure` on `GET /envelopes/:id`, ADR-027 | — |
| T-032 | 16 | T-017, T-018, T-024, T-026 | blocked | each screen's acceptance test — green locally (`web/e2e/alerts.spec.ts`, `rules.spec.ts`, `closures.spec.ts`, `sources.spec.ts`: CSV → mapping wizard → source → finished run with coverage; unmatched assigned); `POST /workspaces/:ws/mapping-suggestions`, local ingest runner, `CLOSURE_SINK=memory` for local stacks, ADR-028 | live source connectors (Snowflake / Sheets / BigQuery need Secret Manager); BigQuery closure sink |
| T-033 | 16 | T-018, T-026 | done | overview < 1.5 s on small golden — green (`web/e2e/overview.spec.ts`: every widget ~0.85 s for an unfetched period, route already loaded; `overview.test.ts`: heatmap = live-leaf totals, endpoint < 1.5 s); `GET /workspaces/:ws/overview`, ADR-029 | — |
| T-034 | 17 | T-022, T-027, T-033 | blocked | Appendix C targets at 100k leaves in the CI load job — job and generator in place (`scripts/load-test.ts`, `.github/workflows/load.yml`: 100,553 leaves, 20 dims, 5 templates, ~31M facts, ~1M comments), ADR-030; small scale: search p95 70 ms, edit 25 ms, search lag 0.2 s pass; grid 461–622 ms (projected measure), roll-up lag 12.6 s fail; full roll-up build > 18 min at 11.8k leaves | red, merged as recorded (2026-09-26): the nightly `load` job tracks it (first spec-scale run: actions run 36250221735); grid needs the planner projection speed-up, roll-up needs a faster refresh. Phase 19 re-run (2026-09-27, main `10da495`, actions run 36292069357): red, the same profile as run 36250221735, so no regression from phase 18 |
| T-036 | 18 | T-017, T-034 | done | preview renders 5 samples; `match_method` on 100% of matched golden facts — green (`naming.test.ts` preview of 5, `seed/golden.test.ts` 100% of matched facts, `match-order.test.ts` external_id / match_key / parse pattern / tuple, `byMethod` on the run summary, `web/e2e/naming.spec.ts`), ADR-031 | — |
| T-037 | 18 | T-026b, T-015, T-026 | done | 5k bars < 500 ms p95; targets as lanes with the effective target per date; as-of matches `/query`; no `@svar/*` PRO — green (`bench/render-budget.tsx` BudgetTimeline 5k bars 100.8 ms p95 with an absolute < 500 ms assertion, `query/timeline.test.ts` on the golden: group totals = /query, as-of envelope by envelope = /query?asOf, annual inherited CPA + Q4 override lanes and `effective` ranges, markers, closures, lz-string filter, paging; `domain/timeline.test.ts`; `timeline/no-pro.test.ts` eslint + license-check names; `web/e2e/timeline.spec.ts` drawer, lanes, scrubber = /query?asOf), ADR-032 | — |
| T-038 | 18 | T-015, T-019, T-037 | done | weighted CPA test vs control; conclude requires a decision and posts a thread comment — green (`experiments/experiments.test.ts` on the golden: read-out = `golden.assertions.ts` = planner `compileTotals` per scope, not the mean of leaf CPAs; conclude 422 without / short decision, one thread + decision comment per linked envelope, in the Decision Timeline, `experiment.concluded` audit, outbox; lifecycle 409s; `experiment` tag, `experiment:running` search, timeline lanes, `experiment` filter attr; `web/e2e/experiments.spec.ts`), ADR-033 | — |
| T-039 | 18 | T-011, T-017, T-026c | done | approved batch appears in `/query` actuals with `source_system='manual'` and lineage; rejected batch reopens as draft — green (`manual-entry/manual-entry.test.ts` on the golden: registry validation with reasons, submit refused while a row has an issue, Finance approval → `/query` actual + 1000.00, spend and KPI facts `source_system='manual'` / `source_run_id` = batch / `match_method='tuple'`, lineage entered by / approved by, `facts.loaded`; rejection → DRAFT with the decision comment, no facts, resubmit; closed-period rows refused; `web/e2e/manual-entry.spec.ts` paste → issues → reason-bearing disabled submit → approval → actuals), ADR-034 | — |
| T-040 | 18 | T-026, T-033 | done | new workspace from the template usable < 60 s; each role's tour end-to-end in Playwright; eslint rule fails a bare `disabled` — green (`home/home.test.ts`: `POST /workspaces` from `default_agency` with demo data in ~0.5 s, registry / policies / rules / view / tours there, `/query` budget = the demo budget, purge in one call; tours per role, completion, org-admin edit = new version; home blocks in order, scope totals = `/query`; `web/e2e/home-tours.spec.ts`: planner, approver, finance and data_admin tours end-to-end, home, workspace from the template in the UI + demo purge; `ui/no-bare-disabled.test.ts`), ADR-035 | — |
| T-041 | 18 | T-020, T-040 | done | setting name in ⌘K opens the admin page — green (`search/search.test.ts`: 19 catalog documents, "pacing rules", "approval pol", "match keys", "metric library", "guided tours" lead with the right deep link, keywords find a setting for a scoped role, `workspace.created` indexes the catalog; `web/e2e/settings-search.spec.ts`: ⌘K → name → Enter opens Pacing rules, Registry on the Metrics tab and Naming on Match keys; a keyword finds Data sources for a planner), ADR-036 | — |
| T-008 | 20 | T-001 | pending | — | GCP project, Terraform state, WIF, IAP, Identity Platform. Done when `/healthz` is reachable behind IAP in dev |
| T-035 | 21 | T-034, T-041, phase 20 | pending | — | plan §16 questions 1, 2, 4, 5, 6, 8, 9, 15; human pen test; staging → prod |

## T-002 assumptions

- Prisma-owned tables are migration `0001_tables`, generated from `schema.prisma`. `migrate deploy` only applies SQL files. Generator, datasource, and enum blocks are multi-line because Prisma rejects the spec's one-line form. `previewFeatures = ["relationJoins"]` is unchanged.
- `taggable.workspace_id` is required. Spec §3.3 turns RLS on for `taggable` using `workspace_id`, and §3.2 omitted the column.
- `search_document.tsv` casts the config to `regconfig` and calls `immutable_array_to_string` for tags. Postgres 16 marks `array_to_string(anyarray, text)` stable, so the spec expression cannot be a stored generated column.
- `envelope_phasing` and `rule_state` get the same parent-exists RLS policy as the other child tables. §3.3 names them and does not emit the statements.
- `eligible_approver` checks the current step's role, group membership, optional `groupId`, and `blockSelfApproval`. FilterGroup scope stays in application `matchesScope`.
- `subscription`, `notification`, and `bulk_change` have `workspace_id` and tenant RLS. `processed_event` is only `(consumer, outbox_id)` plus `processed_at`; it is the publisher dedupe key, not a tenant table.
- Laptop migrate connects as the compose superuser `budget`. Spec §3.1 creates `budget_app` only. `CREATE EXTENSION` and `CREATE ROLE` need a superuser, so `budget_owner` is not a local role.
- `@budget/db` script `prisma` is `prisma`, so pnpm 9 treats `pnpm --filter @budget/db prisma migrate deploy` as the CLI. The root `db:migrate` script is unchanged.

## T-003 assumptions

- Spec §12.2 does not list 20 search strings. The table test uses the qualifier examples from plan §11.3, the combined example in the search tool description, and the parser branches written in §12.2: empty input, free text, negation, quotes, and case folding.
- Relative imports use a `.js` suffix because the package module setting is NodeNext.
- `FilterGroup` is cast to `ZodType<FilterGroupT>`. Zod's defaulted `anchor` makes the schema input differ from the output, and `exactOptionalPropertyTypes` rejects that assignment. `not` on `FilterGroupT` includes `undefined` for the same reason.
- `PolicyConditions` is an interface plus a `ZodType` annotation so the recursive schema has a type. The object shape matches §9.1.

## T-004 assumptions

- `withTenant`, `audit`, `outbox`, and `bumpDataVersion` follow spec §3.4 and §4. `bumpDataVersion` throws if the workspace row is missing instead of using a non-null assertion.
- The isolation test also opens a second transaction on a one-connection pool and checks that `SET LOCAL` is gone after commit.

## T-005 assumptions

- Epic 0.4 search suggest and MCP parameter clauses are not asserted here. T-020 and T-025 own them.
- Country values are the assigned ISO 3166-1 alpha-2 codes, nested under `region` with `parent_value_id`. Northern America maps to `AMER`, the rest of the Americas to `LATAM`, Europe, Africa, and Western Asia to `EMEA`, and the remaining Asia plus Oceania to `APAC`. The source file leaves Taiwan and Antarctica blank; they are parented to `APAC` and `AMER`.
- `fiscal_period` is seeded with no values. Months, quarters, and fiscal years come from the workspace calendar, which this task does not generate.
- Lucide icons are checked against the `lucide` package `icons` map, including the aliases `user-circle` and `filter`. `POST /assets` sanitizes SVG with `svgo` and `dompurify` and stores the bytes in an in-memory `AssetStore`. No object-store server was added.
- A merge writes one `registry.value.merged` audit, one `envelope.dimension.rewritten` audit per affected envelope, and one `registry.changed` outbox row. The row's `envelopeIds` is the re-index signal. The indexer is T-020.
- `value_constraint` applies only when the tuple's when-dimension equals `when_value_code`. The constrained code must then be in `allowed_value_codes`.
- Org-wide dimensions require `isOrgAdmin` because the existing dimension RLS check does not allow `workspace_id` NULL otherwise.
- `dimension_value.path` is an `ltree` column Prisma cannot write, so those inserts are SQL in `@budget/db`.
- Registry HTTP routes are mounted and reject callers until T-009 provides an actor. There is no auth bypass. `GET/POST /metrics` shipped with T-015 (registry module, org admin writes).
- The React `DimensionIcon` contract waits until the web package has a React runtime.

## T-007 assumptions

- Relative imports use a `.js` suffix because the package module setting is NodeNext, same as T-003.
- The planner suite inserts envelope, version, and fact rows in `packages/query-planner/src/planner.test.ts`. Envelope commands are T-010. Phase 4 names that test file as the only place that inserts them directly. Golden totals are added by T-006.
- BigQuery routing and the Redis query cache stay out of this Postgres-path task.
- The target-value subquery binds its metric parameter only on the `exists`, `value`, and `vs_target_pct` branches. The spec builds that subquery before the switch, which leaves an unused parameter on `actual`. Postgres rejects a statement that binds a parameter it does not reference.
- `mentions_user` for `@me` follows the spec expression. The JSON is bound before the `"__ME__"` replace, so the replace does not rewrite the parameter. The suite asserts a concrete user id.
- The cursor is the spec's base64url offset. The stability test covers an uncommitted insert and a committed insert that sorts after the page window.
- `pnpm bench` times `compileQuery` against `packages/query-planner/bench/baseline.json`. It fails when the p50 is more than 10% above that baseline. Since `task/planner-bench-stable` the p50 is divided by a warmed calibration loop; see ADR-006.

## T-026a assumptions

- The spike uses 100,000 in-memory rows, not the database golden. The database-scale proof is T-034. ADR-002 records that.
- The TanStack-only build is `@tanstack/react-table` 8.21.3 plus `@tanstack/react-virtual` 3.14.13. An unvirtualized 100,000-row DOM table was not mounted.
- Glide is `@glideapps/glide-data-grid` 6.0.3. Its React peer range stops at 18. The scroll bench rendered `DataEditor` on React 19.2.4. pnpm reports an unmet peer. These packages stay devDependencies until T-026c ships `BudgetGrid`.
- Visible-window and model-build samples are divided by a same-process CPU calibration. The bench fails when that ratio is more than 10% above `packages/grid/bench/baseline.json`. The cell-batch median fails above 2× that ratio. Scroll fps fails when it drops more than 10%, and is not calibrated.
- `docs/adr/0000-template.md` is the empty ADR shape this phase asked the first spike to add.

## T-026b assumptions

- The spike uses 5,000 in-memory bars, not the database golden. The database-scale proof is T-034. ADR-003 records that.
- `@svar-ui/react-gantt` is 2.7.2. `vis-timeline` is 8.5.4 via the standalone build, so the peer tree (moment, vis-data, xss) stays inside that bundle. These packages stay devDependencies until T-037 ships `BudgetTimeline`.
- The MIT store clears `markers` on init. The marker overlay is our absolutely positioned layer. A `.wx-marker` node fails the proof.
- SVAR `open: true` on a leaf throws because the store walks `task.data` with `forEach`. The bench passes `open` only for tasks that have children. The budget target lane is shown by including that row; the CPA target stays collapsed by omitting it. `toSvarTasks` still records `open: true` on the budget target for the product rule.
- `pnpm bench` divides render p95 by `cpuScaleMs` and fails above 110% of `packages/timeline/bench/baseline.json`. Pan fps fails when it drops more than 10%, and is not calibrated.
- Rendering engine is `@svar-ui/react-gantt`. vis-timeline mounted 5,000 rows in 13625.700 ms p95. The canvas viewport was faster and does not provide a task grid or zoom.

## T-026c assumptions

- `export type QueryRow` was added next to the zod schema so `@budget/grid` can import the row type from spec §18.2. The schema value is unchanged.
- `RowSource.getRows` returns `dataVersion` as a string, which is what §18.2 writes. `QueryResponse.dataVersion` stays a number.
- `hasChildren`, `expanded`, `level`, and `name` are optional fields a source may attach to a row. The domain row does not have them. A row without `hasChildren: true` does not toggle.
- `GridEvents.onSort` is optional. The §18.2 rules name `events.onSort` for a header click, and the sketched interface omitted it.
- A dimension column is a text cell. `editable: true` uses the dimension picker. Date, tag, and text editors are overlay editors on those cell kinds. Nothing in this package calls HTTP. Search is `searchDimensionValues` / `searchTags`.
- Money is parsed and formatted with `decimal.js`. The totals row uses `font-variant-numeric: tabular-nums`. Canvas cells are right-aligned.
- The page cache keeps 32 pages of 200 rows and prefetches 2. It requests the first page when it is created so Glide learns `total` before it asks for a cell.
- `budgetGridScrollFpsP50` is 59.9. The bench fails under 55 and under 90% of that baseline. `budgetGridFirstPaintMs` is 35 and fails above 300 ms or 10% after the spike `cpuScaleMs`. `budgetGridGetCellP95Ms` is 0.005. It fails above 0.2 ms. The 10% band is too tight for that timer (0.0042 ms, then 0.005 ms), so that ratio fails above 2×, the same band T-026a used for its noisy cell sample. The spike baseline numbers were not retuned.
- Storybook 8.6.14 is a devDependency. Glide, React, and React DOM are runtime dependencies. Glide's React peer range still stops at 18. Column titles are the column keys. `@budget/ui/i18n` does not exist yet.
- 59.9 fps does not meet plan epic 0.7's 60 fps. The 100,000-leaf database golden is T-034.

## License-check fix (no task id; ADR-004)

- Until this change, `pnpm license-check` checked no packages and exited 0. The "`pnpm license-check` green" results recorded for T-026a, T-026b and T-026c therefore did not check anything.
- The gate now checks every workspace package's production tree, including transitive dependencies. Six transitive packages with permissive licences outside the allowlist (MIT-0, Python-2.0, CC-BY-4.0, BlueOak-1.0.0) pass as exact-version entries in `scripts/license-exceptions.json`. Any other disallowed licence, and any stale entry, fails the gate.

## RLS org-scoped admin (no task id; ADR-005 addendum)

- Migration `20260924000000_rls_org_scoped_admin` limits the org-admin RLS bypass to `app.org_id`'s workspaces. It also limits org-wide `dimension` rows to their org. `TenantContext.orgId` is now required (`string | null`), and `withTenant()` sets it.
- The planner test helper `runAsApp` derives `app.org_id` from the fixture workspace.
- Migration `20260924010000_rls_dimension_value_processed_event` adds RLS to `dimension_value` (through `dimension`) and `processed_event` (through `outbox`). Outbox consumers must dedupe inside `withTenant()` for the event's workspace.
- `rls.org-admin.test.ts` fails if any public table other than a listed exception lacks enabled and forced RLS.
- Migration `20260924020000_rls_org_tables` adds RLS to `role_assignment` (org-wide read by principal org, workspace-limited write; ADR-005), `metric_definition` (org; org admin writes), `value_constraint` (through `dimension`) and `ingest_run` (through `data_source`).
- Migration `20260924030000_rls_identity_tables` adds RLS to `organization`, `workspace`, `app_user` and `app_group` (org-scoped; ADR-005). The auth lookup uses `withIdentity()`.
- Migration `20260924040000_rls_group_member` adds RLS to `app_group_member` (through `app_group`; the member must be in the same org).
- The remaining exceptions are `fx_rate` (global) and `_prisma_migrations`.

After phase 18, re-run the phase 17 load suite before starting phase 20. That re-run does not have a new task id.

Phase 2 (plan epics 2.1–2.7) and Phase 3 (epics 3.1–3.2) have no §22 tasks. Do not add rows here until a spec PR adds them.

## T-037 assumptions

- The effective target on a date is the most specific one: the envelope's own target before an inherited one, then the shortest range, then the latest start. Only the timeline resolves by date; `/query` keeps `effective_target()` (ADR-032).
- `GET /timeline` also takes `period` (a preset or PeriodSpec, as on `/pacing`) when `from`/`to` are absent: the web does not know the fiscal start month.
- Closures are the only key dates, because there is no holiday or client key-date table. Experiment bars come with T-038.
- The web view loads up to 5,000 envelope bars and says when it stops. It has its own TanStack Query cache, not the Explorer's `RowSource`.
- The grid's third column is "Spent" (% of budget with a pace dot), not the pace index, because the product owner asked for % spent.
- `@svar-ui/react-gantt` and React moved to runtime dependencies of `@budget/timeline`. `vis-timeline` stays a devDependency (bench only).

## T-038 assumptions

- **Permissions:** experiment writes need `envelope.edit_draft` and reads need `envelope.read`. No experiment action is specified (ADR-033).
- **`workspace_id`:** `experiment_envelope` carries it (AGENTS §4), although spec §25.1 leaves it out.
- **Scope of a side:** its filter OR the envelopes linked in that role, restricted to live leaves, for the experiment's window. The new FilterGroup attribute `experiment` (a status, an id, or `<id>:TEST|CONTROL`) expresses it.
- **Concluding** needs at least one linked envelope, so the decision lands in their Decision Timeline. It posts one thread per linked envelope.
- **Absolute criterion:** the reference is the criterion's `value`, and the control side is not read.

## T-039 assumptions

- **Default policy:** "Manual results" (priority 0, `entityType: manual_entry`) needs one FINANCE approval. §26.2's "finance or budget_owner" needs a two-role step, which chain steps do not have (ADR-034).
- **Permissions:** entering, saving and submitting need `envelope.edit_draft`, and submit checks the enterer's scope covers every row. Reading needs `envelope.read`.
- **Rows are saved as typed:** each save returns issues (blocking) and warnings (no budget would take the row; it waits in the unmatched queue).
- **Offline channels:** the default registry gains `tv`, `ooh`, `dooh`, `print`, `radio` and `sponsorship`. Channel colours come from a palette by position, because `dimension_value` has no colour field.
- **Lineage** is `manual_entry_fact`: one row per fact, keyed by batch, row hash and date, with `entered_by` and `approved_by` (the last approver).
- **Golden:** one DRAFT TV batch, so no golden fact totals move.

## T-040 assumptions

- **Home** is `/w/:ws/home`, first in the nav. The Overview stays at `/`. Scopes show % spent (product owner).
- **Tour steps** carry an optional `path`, so a tour can span pages. Defaults per role are written on first use by an org admin.
- **Org-level routes:** `org.admin` is a new route permission, for `GET /workspace-templates`, `POST /workspaces` and `PATCH /tours/:id`.
- **Demo data** is a small generator, not the full golden seed: 9 budgets, 3 CPA targets, and facts to date. `demo = true` is set on envelope, envelope_version, target, target_version, spend_fact and kpi_fact.
- **Purge:** `POST /workspaces/:ws/demo-data/purge` needs `user.manage`.
- **`budget/no-bare-disabled`:** a native element may state its reason in `title`.

## T-041 assumptions

- **Catalog in code:** `SETTINGS` in `@budget/domain`, with fixed ids. These are pages, not tenant data.
- **Visible to every role**, as the admin nav is. Each page enforces its own permissions.
- **Ordering:** settings lead only when a title starts with the typed text.
- **Existing workspaces** get settings on their next re-index.
- **Palette fix:** a single word is searched unless it starts a qualifier key; a new result set highlights its first hit.

## T-034 phase 19 re-run (2026-09-27)

This is the Appendix C job re-run on main `10da495` (after phase 18), at the same scale. Actions run: 36292069357. The dataset was not changed.

**Scale:**

- 100,746 leaves and 172,783 envelopes;
- 24.4M spend facts and 7.0M KPI facts;
- 1.0M comments;
- 20 dimensions and 5 templates;
- a 20 GB database.

**Results:**

| measure | phase 19 | phase 17 (run 36250221735) | target | |
|---|---|---|---|---|
| gridQueryP95Ms | — (500: transaction > 15 s timeout) | — (same) | < 400 | FAIL |
| searchP95Ms | — (500: transaction > 15 s timeout) | — (same) | < 150 | FAIL |
| inlineEditP95Ms | 27 | 27 | < 300 | pass |
| bulkCommit10kMs | 5791 | 5414 | < 10000 | pass |
| rollupLagP95Ms | — (handler transaction expired, ~122 s) | — (same) | < 5000 | FAIL |
| searchLagP95Ms | — (handler transaction expired, ~122 s) | — (same) | < 5000 | FAIL |

**Phases:**

| phase | phase 19 | phase 17 |
|---|---|---|
| scale (bulk SQL) | 19.7 min | 18.9 min |
| search index | 48.3 min | 40.8 min |
| 10k bulk commit | 8.7 s | 8.8 s |

**Read:** no regression from T-036 to T-041. The phase gate ("green on the post-phase-18 code") stays red on the same four measures.

**The fix is outside phase 19:**

- The grid query and search at 1M+ documents exceed the 15 s interactive transaction. They need the planner projection speed-up and a look at search query plans at scale.
- The roll-up and search-lag handlers need a faster, incremental refresh.

## T-034 speed-up run (2026-09-27, PR #51)

This is the spec-scale job on the speed-up branch: `8cbf40c`, actions run 36310988660. The dataset is the same as phase 19: 100,746 leaves and 24.4M spend facts. Every measurement completed. The job then hung in its final cleanup (deleting 24M facts ran into the `spend_month` delete trigger) and was cancelled. That is fixed in `32e3f83`: a 4.7M-row delete now takes 25 s instead of more than 85 minutes. Run 36330340457 re-runs the job on the fix.

| measure | phase 19 (36292069357) | speed-up (36310988660) | target | |
|---|---|---|---|---|
| tree levels via `/tree` (root, country, deep) | 500 (timeout) | 32, 20, 14 ms | < 400 | pass |
| leaf page (`/query`) | 500 | 985 ms | < 400 | FAIL |
| pivot country × platform (`/query`) | 500 | 9,463 ms | < 400 | FAIL |
| gridQueryP95Ms (all scenarios) | — | 9,195 | < 400 | FAIL (the pivot) |
| searchP95Ms | 500 | 500 (timeout) | < 150 | FAIL |
| inlineEditP95Ms | 27 | 30 | < 300 | pass |
| bulkCommit10kMs | 5,791 | 5,944 | < 10,000 | pass |
| rollupLagP95Ms | expired | expired | < 5,000 | FAIL |
| searchLagP95Ms | expired | expired | < 5,000 | FAIL |

**Phases:**

| phase | this run |
|---|---|
| scale | 21.3 min |
| search index | 33.7 min |
| full roll-up rebuild, 5 templates × 2 periods | **5.9 min** (phase 19: did not finish within its 15 min bound) |

**Still to do:**

- **The pivot and large filtered pages** still compute every leaf on read. They need a pre-aggregated cube or a set-based planner path.
- **Search** at about 1M documents still exceeds 15 s.
- **Roll-up lag:** one change's refresh (5 templates × 2 periods, run for each of the change's `budget.changed` events) exceeds the 15 s handler transaction at spec scale. It measured 8.1 s p95 at 19.5k leaves. The next steps are skipping the draft events, which change no cached measure, and coalescing events for the same envelope.

## Product feedback (product owner, 2026-09-26)

Not spec tasks. They are built one PR each, in this order, after phase 19. Phase 20 waits for GCP access.

| # | Item | Status |
|---|---|---|
| 1 | Parent budgets open the right-hand drawer from their group row, on every level and hierarchy | done: `nodeEnvelopeId` on group rows; the marker expands, the name opens |
| 2 | The "(none)" root shows the account name (e.g. Golden) | done: a first-level group with no value is the workspace; deeper, pivot and timeline groups read "No <granularity>" |
| 3 | "Send for approval" is easy to find | done: there was no way to submit a budget draft from Budgets; now a card at the top of the drawer (draft → Send for approval; waiting → open the request or withdraw) and the same action in the notice after an inline edit |
| 4 | Pace in the Budgets tree | done: the cell showed the raw ratio (`0.99032675996…`) with its bar drawn over it; now two decimals like the totals row, with the bar left of the value |
| 5 | Edit the budget family top-down: children as % of the parent (auto-update) or manual (flagged when they do not add up) | done: family card in the drawer, the family editor (% or amount per child, live results down the tree, sum flag), one bulk change for approval; ADR-039 |
| 6 | Roles that set budgets without approval | done: policies match "who is asking" (roles or people); the Approval policies admin page (was a placeholder); the drawer says "Apply now" when a draft needs no approval; ADR-040; the Roles admin page (people and groups, scoped roles, add a person by email) |
| 7 | Dynamic quarters, partitions, views; end and reopen a quarter | done: the fiscal calendar is the workspace's rows (calendar or 4-4-5 / 4-5-4 / 5-4-4, custom partitions) and every "this quarter" follows it; Admin › Fiscal calendar (start month, generate a year, custom periods, close / reopen); the Explorer picks any period; ADR-041 |
| 8 | Overview: % of budget spent, user-picked groupings, platforms from the registry | done: the Spent tile (% of budget, % of the period gone) replaces the pace number; heatmap cells show % spent (colour: spend against time); rows × columns are any two granularities, in the URL; every column comes back (top 8 first, "Show all") |
| 9 | Edit budgets from the Overview | done (2026-09-28): a heatmap cell opens its leaf budgets beside the heatmap; each takes a new amount (a draft, then Send for approval), or the whole cell changes by a percentage through the bulk preview and the approval policy; "Open in Budgets" keeps the old drill-down |
| 10 | Choose what the Overview shows | done (2026-09-28): Customise turns each tile and panel on or off, saved per person as a private `overview` saved view (a workspace-shared one is the default); ADR-045 |
| 11 | The Overview's period picker lists the fiscal calendar (years, quarters, custom periods) as the Explorer does; seven-figure amounts no longer cut off in the tiles | done (2026-09-28) |

No placeholder screens are left (2026-09-27):

- **Admin › Roles:** everyone in the org and every group, with their roles here. Give a role for the whole workspace or only some values of one granularity, or revoke it. An org admin adds a person by email (`GET`/`POST /workspaces/:ws/members`).
- **Admin › Tags:** usage counts; create, rename, recolour, merge; each tag opens its budgets.
- The `Pending` component is removed.

## Heavy queries: spec §6.2 routing rule (T-007b, 2026-09-27)

Deferred from T-007 and now built (ADR-042).

- **BigQuery routing:** with `BIGQUERY_DATASET` set, heavy grouped queries (over 13 months, or more than 200k estimated rows) run in BigQuery SQL on the warehouse replica. Everything else stays on Postgres.
- **Query cache:** `/query` results are cached in Redis, keyed by data version. Every response names its `engine`.
- **Tried and dropped: a set-based Postgres planner.** It returned the same answer as the per-envelope planner. Measured at 100 shards, it was either fragile or no faster:
  - with joins it was fast on analysed data (pivot 460 ms), but took 118 s on a freshly loaded workspace;
  - with per-envelope lookups it matched the per-envelope planner (pivot about 950 ms), and the roll-up rebuild was 32–42 s against 25.5 s before.
- **Still open:** Postgres grid p95 at scale, and loading the warehouse replica (T-017, needs client credentials).

## T-034 search at scale (2026-09-27, ADR-043)

**Changes:**

- Exact matching (full text or substring) comes first.
- Typos are corrected against the workspace's word list (`search_term`), only when nothing matches exactly.
- Each type ranks and counts at most 1,000 matches, reported as "1000+".

**Measured at 100 shards (227k documents):**

- the load job's text searches: 2.0–2.2 s → 26–78 ms;
- qualifier-only searches: 4–129 ms;
- typos: about 2 s with 0–1 results → 180–265 ms with results.

The spec-scale load job re-measures this on this branch.

## T-034 roll-up lag: skip draft events (2026-09-27)

- The rollup worker now skips `budget.changed` events of kind `draft`. A draft changes no cached measure: the cache holds approved budgets, spend, projections and pending counts; a draft is unapproved, and a pending envelope can't take one.
- The lag test's change (a draft, then an auto-approved submit) now costs one refresh instead of two.
- Still open: one refresh at spec scale (5 templates × 2 periods). Profiling continues.

## Roll-up pendingCount after status-only writes (T-022 follow-up, 2026-09-27, ADR-044)

- Submitting for approval, rejecting, requesting changes, withdrawing, re-routing on a move, and closing or restating a period change `envelope.status` to or from PENDING without a `budget.changed`. The cached `pendingCount` stayed stale.
- `rollup-worker` now also consumes `approval.changed` (status-changing actions only), `period.closed` and `period.restated`, and refreshes the affected envelopes' paths. No write emits a second outbox row.
- Test: `apps/workers/src/rollup/rollup.test.ts`, "status-only events … refresh pendingCount to what a rebuild gives".

## Product feedback, round 3: Home (2026-09-28)

- **Greeting:** "Good morning / afternoon / evening, <first name>".
- **Names:** each person can change their own name from the top bar (`PATCH /me`, through the `app_set_my_name()` definer function, which changes only their own name; audited).
- **Blank workspace:** Home says "Add your first budgets", with a five-step getting-started list: budgets, spend data, people, approval policies, pacing rules.
- **With budgets:** a summary strip (the year's budget, % spent against % of the year gone, open alerts, waiting on you) above "Waiting on you".
- **New budget:** Budgets gets a "New budget" button for a top-level budget (there was no way to add a first one; Add child needs a parent).
- **Fix:** Home's saved views now include workspace-shared views; it asked for visibility values that don't exist.
## Product feedback, round 3 (2026-09-28)

- **An org admin can approve anything**, their own changes included: `eligible_approver()` (migration `20260930000000_org_admin_approves`) and `eligibleApprover()` let an org-wide ORG_ADMIN decide any step. Everyone else keeps the step role, the group and blockSelfApproval.

## Product feedback, round 3: tagging (2026-09-28)

- **Filter by tag:** Budgets › Add filter › Tag (the planner's `tag` attribute), also in rule scopes.
- **Tag many at once:** Budgets › Select shows checkboxes in the grid; tick rows, then Tag or Untag in one call. A new tag is created on the spot by anyone who may create tags.
- **Chips on alerts, approval requests and targets**, not only budgets. They read `GET /workspaces/:ws/tags/applied`, and a new tag can be created from the chip picker.
## Product feedback, round 3: pacing and alert rules fully editable (2026-09-28)

- **New in the editor:** the period a rule is measured over, whether it shows in the app, who its alerts are assigned to (`delivery.assignTo`, default the budget's owner), active on creation, Duplicate, and Delete.
- **Delete** (`DELETE /rules/:id`, migration `20260930020000_rule_deleted_at`) keeps the rule for its alerts' history, stops it, and resolves its open alerts. The name can be reused.
- **Removed:** the email field, which was saved but never delivered; stored emails are kept.
- **Fixed:** opening a default rule crashed the editor (its empty scope `{}` reached the filter bar).

## Product feedback, round 3: Slack notifications and bot (2026-09-28, ADR-046)

- **Alert messages** carry Acknowledge / Snooze a week / Resolve.
- **Approval requests** carry Approve / Reject; Reject asks for a reason in a Slack form.
- **Acting from Slack:** each click runs the app's command as the Slack user's Budget OS account (matched by email; the workspace must be linked to that Slack team). The posted message is edited when the alert or request changes, from Slack or the app.
- **`/budget`:** `alerts`, `search <text>`, or a budget's name, answered privately.
- **Admin › Slack:** connection, Link, channels (default, alerts, severities), a test message, and the setup steps with the app manifest.
- **Local runner:** now delivers notifications (in-app and Slack), and every workspace of the local stack's org.
- **Needs a real Slack app to use:** the bot token and signing secret, plus a public URL for buttons and /budget.

## Product feedback, round 4: Settings section (2026-09-28)

- **The sidebar's Admin section** keeps Registry, Pacing rules, Roles and Tags, plus **Settings**.
- **Settings** is a hub page with: Workspace, Approval policies, Slack, Data sources, Naming templates, Fiscal calendar, Workspace templates, Tours. On any of them, a strip above the page moves between them, and the sidebar's Settings item stays active.
- **New Settings › Workspace:** rename the workspace (`GET`/`PATCH /workspaces/:ws/general`, `user.manage`, audited), and see its currency, fiscal-year start, slug and id.
## Product feedback, round 4: Budgets (2026-09-28)

- **Pace:** the period's spend against the budget's share of the period (`budget_in_period`, ADR-047). A year-long budget viewed over one quarter no longer reads 0.15.
- **Default period:** Budgets opens on the fiscal year.
- **Statuses:** read as words (Draft, Waiting for approval, Approved, Locked (period closed), Archived; groups "N waiting"), with an explanation on the drawer's chip.
- **Rename:** a budget is renamed from its drawer. A custom name wins over the display naming template (`envelope.name_custom`); "use the template name" undoes it.
- **Adding budgets:** "New budget" (#68) adds a top-level budget; Add child / Split add below one.
## Product feedback, round 4: admins apply directly (2026-09-28)

- A workspace admin's or org admin's own change is approved on submit, with no approval step. `matchPolicy` returns the built-in "Admins apply directly" policy before the workspace's own, so every write path gets it: edits, bulk, family, structure, targets and manual entry, plus the drawer's "Apply now".
- The Approval policies page says so.

## Product feedback, round 4: data sources from BigQuery and Snowflake (2026-09-28)

- **New data source:** step 1 is now Connect, with BigQuery, Snowflake, Google Sheets or a CSV file.
- **Warehouses and Sheets:** you enter the connection (validated against `SourceConfig`, credentials only as a Secret Manager name) and the table's columns, then map them as for a CSV, then save. The backend already accepted these source types.
- **Test the connection:** shown, and disabled with a reason until the connector's credentials are set up. For warehouses, "Run it now" is off by default.

## Product feedback, round 5: a free OpenAI workspace (2026-09-28)

- **An admin's approval is final** (#77, ADR-048): an org admin, or a workspace admin in scope, may decide any step, and their approve approves the request outright.
- **Free hierarchies** (#78, ADR-049):
  - a template's levels may come in any order; `allowedParents` now governs values only;
  - in the Budgets tree, a group with no value for its level folds into the level above, so a budget with no granularities is at the top and an unused Client level never shows.
- **Edit granularities** (#79): a budget's granularities change from its drawer (`PATCH /envelopes/:id` `dimensionValues`). They're registry- and scope-checked, audited, and the roll-ups rebuild.
- **Budget structure** (ADR-050): Budgets and the Timeline open on the budgets as built. Top-level budgets come first, then each one's children; parents are rows with their own amount and their subtree's spend. The hierarchy templates remain in the picker.

## Product feedback, round 6: UX/UI audit, BudgetOS identity, superadmins (2026-09-28)

The product owner asked for a usability audit of the whole system by a UX/UI specialist, a BudgetOS logo at the top, superadmins who create and delete workspaces, and workspace admins confined to their own workspace. The audit and the plan are in `docs/UX_AUDIT_AND_ADMIN_PLAN.md` (nothing built yet). Tasks, in execution order, each one PR:

| ID | Phase | Task | Status |
|---|---|---|---|
| UX-001 | A | Tour auto-start no longer hijacks navigation | done |
| UX-002 | A | Shell: only `<main>` scrolls; sticky page header and decide bar | done |
| UX-003 | A | Nav and Settings gated by permissions | done |
| UX-004 | A | Branded 403 / 404 pages | done |
| UX-005 | A | BudgetOS logo, favicon, page titles, sign-in | done |
| UX-006 | A | AA-contrast tokens; one `StatusChip` vocabulary | done |
| UX-007 | A | Toasts, skeletons, empty states | done |
| UX-008 | A | One "budget this fiscal year" definition (ADR-051) | done |

Phase A notes (2026-09-28): tours never start by themselves (Home invites; a close records a skip, migration `20261001000000_tour_dismissed`); only `<main>` scrolls; nav and Settings follow `/me` permissions; branded sign-in, 403 and no-workspace pages; the BudgetOS logo, favicon and per-page tab titles; AA tokens with a contrast test; one `StatusChip`; toasts (`meta.success` / `meta.error` on mutations), skeletons and empty states; Home and the Overview tiles use Budgets' total (ADR-051). The web UI says BudgetOS; Slack messages and exports still say Budget OS until decision D1 is confirmed. The Explorer e2e totals test waited on the wrong load since ADR-050 and now waits for the template's tree.
| DS-001 | B | `Input`, `NumberInput`, `Textarea`, `Select` (native, styled), `FormField`; every hand-styled field migrated (196); lint `budget/no-raw-form-controls` is an error | done |
| DS-002 | B | Radix `Dialog`, `Modal`, `SheetContent`, `Popover`, `Menu`, `Tabs`; `Avatar`, `Kbd`; the six hand-rolled modals trap focus, close on Escape and a backdrop click | done |
| DS-003 | B | Shell v2: Help and user menus, the notifications bell (`GET /me/notifications`, `POST /me/notifications/read`), `?` shortcuts and `g` go-to keys, an icon rail below 1280 px and a slide-in panel on phones | done |
| DS-004 | B | Table primitives; Alerts row selection with a bulk bar; the inbox with avatars and overdue dates; Targets shows Draft only when something is in draft | done (grouping alerts by rule left out: grouping stays server-side, AGENTS §4) |
| DS-005 | B | Budgets toolbar: the structure actions in one menu; money columns wide enough for their totals, with the full value on hover | done |
| ORG-001 | C | Superadmin naming and marking (ADR-052): "Superadmin" everywhere, `isSuperadmin` on `/me`, a badge in the workspace, `audit_event.actor_context` | done |
| ORG-002 | C | Archive and restore: `workspace.status`, 423 on writes, hidden from members, workers skip it, a banner | done |
| ORG-003 | C | Delete (archived, typed name, reason), undelete within `WORKSPACE_RETENTION_DAYS`, the purge job keeping audit rows | done |
| ORG-004 | C | Org console: Workspaces (new with a first admin, archive, restore, delete) and People (deactivate, reactivate); "Manage workspaces" in the switcher | done |
| ORG-005 | C | Members scoped to the workspace; workspace admins add people by email with a role; one admin always kept; group sync superadmin-only | done |
| ORG-006 | C | Template granularities become the new workspace's own; shared rows labelled | done (existing orgs keep their shared rows; decision D4) |
| ORG-007 | C | Workspace metrics (`metric_definition.workspace_id`, RLS) and workspace tours edited by workspace admins | done |
| ORG-008 | C | Boundary tests: permission matrix rows, `lifecycle.test.ts`, `members.test.ts`, `consumer.test.ts`, e2e `org-console.spec.ts` | done |
| UX-009 | D | Settings hub grouped by purpose (Workspace, People and approvals, Taxonomy, Pacing and alerts, Data and integrations, Onboarding), the sidebar's admin pages included; the nav's "Sources" is "Spend data" | done |
| UX-010 | D | A visible focus ring everywhere; `?` shortcuts; an accessibility smoke over 16 screens (`e2e/a11y.spec.ts`) | done (axe-core is MPL-2.0, outside the allowlist, so the checks are written in the spec) |
| UX-011 | D | No text under 12 px; Home's recent budgets with the same name show their parent | done |
| UX-012 | D | Dark mode: tokens checked for AA like the light ones, the grid's canvas theme, Light / Dark / System in the user menu | done |

All four phases are built (2026-09-28): PRs #83 (A), #84 (C), #85 (B) and the Phase D PR, stacked in that order. Decisions D1–D9 in the plan stay open; the builds follow the plan's proposals.

Decisions D1–D9 in the plan's Part 5 are open for the product owner.
