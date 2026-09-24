# Task status

Source of truth for scope: `BUDGET_OS_BUILD_SPEC.md` §22 (version 0.5).
Source of truth for order and gates: `docs/LOCAL_BUILD_PHASES.md`.

Repo on 2026-09-24: T-001 through T-007, T-009, T-010, T-011, T-012, T-013, T-026a, T-026b, and T-026c are done. Later tasks are `pending`.

Bench maintenance (`task/bench-macos`, 2026-09-23, not a §22 task): `pnpm bench` runs on macOS through `CHROME_PATH` or the default Chrome location. turbo runs the grid, timeline and query-planner benches one after another. ADR-002 `## Notes` has the details.

Planner bench maintenance (`task/planner-bench-stable`, 2026-09-23, not a §22 task): the `compileQuery` bench warms up for 200k calls, times 31 batches, and gates the p50 ratio to a planner-shaped calibration loop at 10%. The baseline was re-recorded on an Apple M2, and again after the T-007 fixes (PR #1) merged: the fixed compiler does more work per call, so the ratio moved from 0.6406 to 1.018. ADR-006 has the method and the numbers.

Status values: `pending` | `in_progress` | `done` | `blocked`.
A task is `done` only when its §22 "Done when" test is green and the phase gate in `LOCAL_BUILD_PHASES.md` passed. Partial GCP clauses stay `blocked` until that gate passes; do not mark the whole task `done` on the local clause alone when the phase doc says the task is split.

| ID | Phase | Predecessors | Status | Local gate | Still blocked after local gate |
|---|---|---|---|---|---|
| T-001 | 1 | — | done | `pnpm install && pnpm typecheck` | — |
| T-002 | 2 | T-001 | done | `pnpm db:migrate` on fresh Postgres 16; RLS test | — |
| T-003 | 2 | T-001 | done | zod round-trip; `parseSearch` 20 cases | — |
| T-004 | 2 | T-002, T-003 | done | concurrent `SET LOCAL` isolation test | — |
| T-005 | 3 | T-002, T-004 | done | registry acceptance, excluding search and MCP clauses | search qualifier (T-020); MCP parameter (T-025) |
| T-007 | 4 | T-002, T-003, T-004 | done | planner suite including property tests, on SQL fixtures | — |
| T-026a | 5 | T-001 | done | bench numbers in ADR-002 | DB golden at 100k leaves is T-034 |
| T-026b | 5 | T-001 | done | 5k-bar bench; target lane + marker overlay; ADR-003 | same |
| T-026c | 6 | T-026a | done | ≥ 55 fps p50 at 100k in-memory rows; storybook; `pnpm license-check` | plan epic 0.7 still says 60 fps; re-measure at T-034 |
| T-009 | 7 | T-002, T-003, T-004 | done | permission matrix, every role × action | live Google SSO and live Google Groups (plan §16.6) |
| T-010 | 8 | T-004, T-009 | done | 409 with `currentVersionId` | — |
| T-011 | 8 | T-010 | done | epic 1.3 acceptance; cap trigger | — |
| T-006 | 9 | T-005, T-010, T-011 | done | `pnpm db:seed` < 60 s; assertions file committed | threads, facts, targets, closures added by later tasks |
| T-012 | 10 | T-006, T-011 | done | replay over golden history matches assertions | — |
| T-013 | 11 | T-010 | done | 10k rows < 10 s | — |
| T-014 | 11 | T-010, T-011 | pending | cap re-validation | — |
| T-015 | 11 | T-007, T-010 | pending | CPA roll-up = spend / conversions at every level | — |
| T-016 | 12 | T-004 | pending | duplicate delivery applies once | live Pub/Sub topic (GCP phase) |
| T-017 | 12 | T-002, T-005, T-010 | pending | ≥ 99% match on golden CSV; rejected-rows report via the GCS emulator named in §22 | live Snowflake, Sheets, BigQuery (plan §16.4; no credentials in spec) |
| T-018 | 12 | T-015, T-017 | pending | consecutive-days test; no duplicate open alerts | Cloud Scheduler 15 min trigger (GCP phase) |
| T-019 | 12 | T-011 | pending | blocking thread blocks submit; mention notifies | — |
| T-020 | 12 | T-016 | pending | index lag < 5 s on small golden; suggest API | p95 < 150 ms at 1M docs is the T-034 load job |
| T-021 | 12 | T-016, T-018, T-019 | pending | Slack Block Kit snapshot tests | live Slack workspace |
| T-022 | 12 | T-007, T-016 | pending | tree totals = pivot totals on golden | — |
| T-023 | 13 | T-007 | pending | CSV/XLSX export respects filter | Sheets push; BigQuery views queryable (GCP phase) |
| T-024 | 13 | T-011, T-007 | pending | locked envelope rejects draft with 423 | BigQuery closure tables (GCP phase) |
| T-025 | 14 | T-007, T-012, T-020 | pending | tools return golden numbers; read-only guard test | IAP and per-user OAuth on Cloud Run (GCP phase) |
| T-026 | 15 | T-009, T-025 | pending | Playwright navigates every §18.1 route with a test JWT | design-team token file is not in the repo |
| T-027 | 16 | T-026, T-026c, T-007, T-022 | pending | Playwright: filter → URL → reload; inline edit conflict; pivot = tree | — |
| T-028 | 16 | T-020, T-026 | pending | Playwright qualifier autocomplete | — |
| T-029 | 16 | T-011, T-012, T-026 | pending | Playwright decide flow | — |
| T-030 | 16 | T-015, T-019, T-026 | pending | Playwright mention flow | — |
| T-031 | 16 | T-005, T-026 | pending | Playwright add-dimension < 10 s into filters | search suggest clause waits for T-020, already required above |
| T-032 | 16 | T-017, T-018, T-024, T-026 | pending | each screen's acceptance test | live source connectors |
| T-033 | 16 | T-018, T-026 | pending | overview < 1.5 s on small golden | — |
| T-034 | 17 | T-022, T-027, T-033 | pending | Appendix C targets at 100k leaves in the CI load job | not a laptop default |
| T-036 | 18 | T-017, T-034 | pending | preview renders 5 samples; `match_method` on 100% of matched golden facts | — |
| T-037 | 18 | T-026b, T-015, T-026 | pending | 5k bars < 500 ms p95; as-of matches `/query`; no `@svar/*` PRO | — |
| T-038 | 18 | T-015, T-019, T-037 | pending | weighted CPA test vs control; conclude requires a decision and posts a thread comment | — |
| T-039 | 18 | T-011, T-017, T-026c | pending | approved batch in `/query` with `source_system='manual'`; rejected batch reopens as draft | — |
| T-040 | 18 | T-026, T-033 | pending | template workspace usable < 60 s; four role tours in Playwright; eslint fails a bare `disabled` | — |
| T-041 | 18 | T-020, T-040 | pending | setting name in ⌘K opens the admin page | — |
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
- Registry HTTP routes are mounted and reject callers until T-009 provides an actor. There is no auth bypass. `GET/POST /metrics` stays with T-015.
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
