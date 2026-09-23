# Task status

Source of truth for scope: `BUDGET_OS_BUILD_SPEC.md` §22 (version 0.5).
Source of truth for order and gates: `docs/LOCAL_BUILD_PHASES.md`.

Repo on 2026-09-23: T-001 through T-005 and T-007 are done. Later tasks are `pending`.

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
| T-026a | 5 | T-001 | pending | bench numbers in ADR-002 | DB golden at 100k leaves does not exist yet |
| T-026b | 5 | T-001 | pending | 5k-bar bench; target lane + marker overlay; ADR-003 | same |
| T-026c | 6 | T-026a | pending | ≥ 55 fps p50 at 100k in-memory rows; storybook; `pnpm license-check` | plan epic 0.7 still says 60 fps; re-measure at T-034 |
| T-009 | 7 | T-002, T-003, T-004 | pending | permission matrix, every role × action | live Google SSO and live Google Groups (plan §16.6) |
| T-010 | 8 | T-004, T-009 | pending | 409 with `currentVersionId` | — |
| T-011 | 8 | T-010 | pending | epic 1.3 acceptance; cap trigger | — |
| T-006 | 9 | T-005, T-010, T-011 | pending | `pnpm db:seed` < 60 s; assertions file committed | threads, facts, targets, closures added by later tasks |
| T-012 | 10 | T-006, T-011 | pending | replay over golden history matches assertions | — |
| T-013 | 11 | T-010 | pending | 10k rows < 10 s | — |
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
- `pnpm bench` times `compileQuery` against `packages/query-planner/bench/baseline.json` and fails when the p50 is more than 10% above that baseline.

After phase 18, re-run the phase 17 load suite before starting phase 20. That re-run does not have a new task id.

Phase 2 (plan epics 2.1–2.7) and Phase 3 (epics 3.1–3.2) have no §22 tasks. Do not add rows here until a spec PR adds them.
