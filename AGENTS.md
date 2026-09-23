# AGENTS.md — how to work on Budget OS

You are a coding agent working in the Budget OS monorepo. This file tells you where things are, what the rules are, and how to pick up and finish a task. Read it fully before your first change. It is deliberately short; the detail lives in two documents you must open when a task points to them.

## 1. Read these, in this order

1. `AGENTS.md` (this file) — rules and workflow.
2. `BUDGET_OS_MASTER_PLAN.md` — the *what* and *why*. Section numbers (§) are referenced everywhere. Version 0.5. Spec §1 and plan Appendix D name this file `docs/BUDGET_OS_MASTER_PLAN.md`; this checkout still has it at the repo root.
3. `BUDGET_OS_BUILD_SPEC.md` — the *how*: repo layout, versions, schema, SQL, zod schemas, planner, contracts, frontend, workers, infra, tests, **task list (§22)**. Version 0.5. Same path note as the plan. Where the spec gives code, use that code as the starting point and keep its names, signatures and file paths.
4. `docs/LOCAL_BUILD_PHASES.md` — local execution order, dependency corrections, and the validation gate for each phase.
5. `docs/TASKS_STATUS.md` — which spec tasks are done. Update it at the end of every task.

Precedence when they disagree: spec code > spec prose > plan > your judgement. If you must deviate, write an ADR (`docs/adr/0000-template.md`) and cite it in the PR. If all three are silent, apply §4 below, choose the simplest option that satisfies the task's "Done when", and state the assumption in the PR under `## Assumptions`.

## 2. Repository map (spec §1 is authoritative)

```
apps/api            NestJS REST API, OpenAPI generated on build
apps/web            React 19 + Vite + TanStack Router SPA
apps/mcp            read-only MCP server (Streamable HTTP)
apps/workers        ingest, pacing, rollup, search-indexer, notify, export, outbox-publisher
packages/domain     @budget/domain — zod schemas, enums, FilterGroup AST, QueryRequest/Response, permissions, errors, ids
packages/db         @budget/db — Prisma schema, hand-written SQL migrations, withTenant(), audit, outbox, golden seed
packages/query-planner  @budget/query-planner — FilterGroup → SQL, group-by, pivot, as_of, measures
packages/grid       @budget/grid — Glide Data Grid adapter (spec §18.2)
packages/timeline   @budget/timeline — SVAR Gantt core adapter (spec §23)
packages/ui         @budget/ui — shadcn components on the design team's tokens
packages/ai         @budget/ai — the only place that calls OpenAI
infra/              Terraform, one module per service
docs/               plan, spec, adr/, runbooks/
```

## 3. Commands (repo root)

| Command | Purpose |
|---|---|
| `pnpm install` | Node 22 (`.nvmrc`), pnpm 9 |
| `pnpm dev` | docker compose (postgres:16, redis:7) + migrate + seed small golden + api + web |
| `pnpm typecheck` · `pnpm lint` · `pnpm test` | must be green before every commit |
| `pnpm test:acceptance` | epic-level acceptance suites; run before marking an epic done |
| `pnpm test:e2e` | Playwright against `pnpm dev` |
| `pnpm bench` | grid / timeline / planner benchmarks vs `bench/baseline.json`; fails on > 10% regression |
| `pnpm license-check` | fails on any dependency outside `MIT;Apache-2.0;BSD-2-Clause;BSD-3-Clause;ISC;0BSD;CC0-1.0;Unlicense` |
| `pnpm db:migrate` · `pnpm db:seed [--size small\|large]` · `pnpm db:reset` | database |
| `pnpm --filter @budget/db prisma migrate dev --name <task-id>` | new Prisma migration; hand-written SQL goes in `packages/db/prisma/migrations/<timestamp>_<name>/migration.sql`, idempotent (`IF NOT EXISTS`) |

## 4. Non-negotiables

**Dependencies and licences**
- Open source only: MIT / Apache-2.0 / BSD / ISC / 0BSD. No paid tiers, no "PRO" scopes. Forbidden by name: AG Grid, Bryntum, Syncfusion, MUI X Pro/Premium, SheetJS Pro, TipTap Pro, any `@svar/*` PRO package. `pnpm license-check` and an eslint `no-restricted-imports` rule enforce this.
- Do not add a dependency for something under ~50 lines. Do not change a pinned major version (spec §2) without an ADR.

**Data**
- Every tenant table has `workspace_id uuid not null` and an RLS policy. Every request runs inside `withTenant()`. Application code never uses the owner role.
- Money is `Decimal` (decimal.js) in code and `NUMERIC(18,2)` in Postgres. Never `number`. Every amount carries `currency`; converted amounts carry `fx_rate_id`.
- Timestamps are `timestamptz` UTC; business dates (`period_date`, `start_date`, `end_date`) are `date`. ISO strings at the boundary.
- IDs are UUID v7 from `@budget/domain/ids`.
- Budgets and targets are never updated in place: a change is a new `envelope_version` / `target_version`. Versions, approvals, decisions, comments, facts and audit rows are never hard-deleted (`deleted_at`).
- Every write path emits exactly one `audit_event` **and** one `outbox` row in the same transaction. Missing either is a bug.
- Business concepts are rows, not columns: dimensions, values, metrics, policies, rules, tags, naming templates, tours, workspace templates. If you are adding a column named after a business concept, stop and use the registry.
- SQL strings live only in `packages/db` and `packages/query-planner`. Everything else uses Prisma or the planner.
- Filters are the `FilterGroup` AST from `@budget/domain`. No ad hoc query params. API, grid, timeline, alerts, saved views and MCP all use it.
- Derived KPIs (CPA, ROAS, CPM…) are computed at query time from `spend_fact` and `kpi_fact`. Never store a computed KPI.
- `apps/mcp` is read-only: tools import only from `queries/`, never `commands/`. CI has a guard test for this.
- All LLM calls go through `@budget/ai` and use OpenAI only.
- Secrets come from Secret Manager via environment at runtime. `.env.example` has placeholders; never commit real values.

**Code**
- TypeScript `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. No `any` except at an I/O boundary where zod parses immediately. No `@ts-ignore`.
- Validate every external input with the `@budget/domain` schema at the boundary: HTTP body/query, Pub/Sub message, file row, MCP tool args. Trust only types after that.
- Errors: throw `DomainError(code, message, details)` from `@budget/domain/errors`; the HTTP layer maps codes (`NOT_FOUND`→404, `FORBIDDEN`→403, `CONFLICT`→409, `VALIDATION`→422, `CAP_EXCEEDED`→422, `LOCKED`→423). Never throw strings; never swallow errors.
- Logging: `pino`, JSON, always `requestId`, `workspaceId`, `actorId` when known. No `console.log` in committed code.
- NestJS: one module per aggregate; thin controllers; logic in `*.service.ts`; SQL beyond simple Prisma in `*.repository.ts`; writes in `commands/`, reads in `queries/`.
- Web: filter/grouping/view state lives in URL search params (TanStack Router `validateSearch`), server state in TanStack Query, no `useEffect` for fetching, no `localStorage` for data. Sorting/filtering/grouping/roll-ups are server-side; the grid and timeline never compute them.
- Every disabled control has a `reason` (`<Button disabled reason="…">`); eslint `budget/no-bare-disabled` enforces it.
- All user-facing strings go through `@budget/ui/i18n` keys.
- Every tour-target element has a `data-tour="…"` attribute (spec §27).

**Process**
- One task per PR. Branch `task/T-016-query-planner`. Commits `T-016: compile predicates to SQL`.
- Touch only the files the task lists; if you must touch more, say why under `## Out-of-scope changes`.
- Never edit an applied migration; add a new one.
- Keep the golden dataset in sync: a new entity type gets seed rows in `packages/db/seed/golden.ts` and a totals assertion in `golden.assertions.ts`.

## 5. Picking up a task

1. Open `docs/TASKS_STATUS.md` and `docs/LOCAL_BUILD_PHASES.md`. Take the earliest phase that is not done, then the earliest task in that phase. Do not pick the lowest task id. The §22 table is not sorted in execution order (`T-035` is last; `T-026a`/`T-026b`/`T-026c` sit with the spikes). Where `LOCAL_BUILD_PHASES.md` moves a task, that move is a recorded assumption, not permission to invent scope.
2. Read the spec section(s) the task cites, then the plan sections they reference, then the existing code in the task's file list.
3. Write the "Done when" check as an automated test first. Watch it fail.
4. Implement the smallest change that makes it pass, using the spec's code as the starting point.
5. `pnpm typecheck && pnpm lint && pnpm test && pnpm license-check`. If the task touches grid, timeline or planner: `pnpm bench`.
6. Update `docs/TASKS_STATUS.md`. Open the PR with the template in §7.

## 6. Definition of done (every task)

- [ ] "Done when" from spec §22 satisfied and asserted by a test in this PR
- [ ] Any changed shape is a zod schema in `@budget/domain`; OpenAPI regenerated (`apps/api/openapi.json`) and web client regenerated
- [ ] Any changed table has a migration (reversible) and an RLS policy; Prisma-owned vs SQL-owned per spec §3
- [ ] Any new write emits `audit_event` + `outbox`; the test asserts both
- [ ] Any new endpoint has a permission check and a row in the permission-matrix test
- [ ] Works on `pnpm dev` with the small golden dataset; `pnpm bench` unchanged or improved where relevant
- [ ] Runbook / README touched if operations change; ADR if a decision was made
- [ ] All checks green locally

## 7. PR template

```
## Task
T-0xx — <title> (Epic x.y — /goal: <paste the goal line from the plan>)

## What changed
- ...

## Assumptions
- ... | none

## Out-of-scope changes
- ... | none

## How to verify
1. pnpm dev
2. ...

## Checklist
- [ ] test for "Done when"   - [ ] schema/migration/RLS   - [ ] audit + outbox
- [ ] permissions            - [ ] openapi regenerated    - [ ] license-check
```

## 8. Where to look

| Working on | Spec | Plan |
|---|---|---|
| Repo, versions, scripts | §1–2 | — |
| Tables, RLS, migrations, roles | §3 | §4 |
| Tenancy wrapper, audit, outbox | §4 | §4.6, §5.3 |
| zod schemas, FilterGroup, QueryRequest/Response, permissions | §5 | §11.2, §10.2, §7 |
| Planner, measures, pivot, as_of | §6 | §10.2, §5.3 |
| Envelopes, versions, phasing, bulk, move/split/merge | §7 | §4.3, §9.3 |
| Dimension registry, hierarchy templates, icons | §8 | §4.2 |
| Approval policies, requests, decisions, timeline | §9 | §8.1–8.3 |
| Targets, metric library, effective target | §10 | §4.8 |
| Pacing rules, alerts | §11 | §8.4 |
| Search index, qualifiers, suggest | §12 | §11.3 |
| Threads, comments, mentions, tags | §13 | §8.6, §4.9 |
| Ingestion connectors, mapping, matching, unmatched | §14, §24.3 | §6.1, §4.10 |
| Closures, restate | §15 | §4.5 |
| MCP server | §16 | §6.4 |
| HTTP routes, headers, idempotency | §17 | Appendix B |
| Web routes, Explorer grid, filter bar, search UI | §18 | §11 |
| Workers, outbox publisher | §19 | §5.1 |
| Terraform, envs, CI | §20 | §5.2 |
| Golden dataset, acceptance, load | §21 | §12, Appendix C |
| Timeline endpoint and `@budget/timeline` | §23 | §4.11, §11.9 |
| Naming templates, match keys | §24 | §4.10 |
| Experiments | §25 | §4.12 |
| Manual result entry | §26 | §6.1 |
| Home, tours, workspace templates | §27 | §11.7 |

## 9. Things that look reasonable here but are wrong

- Storing CPA, ROAS or pace index in a table (derive at query time).
- Adding `country`, `platform`, `objective` as columns (they are dimension values).
- `UPDATE envelope_version SET amount = …` (create a new version).
- Sorting or grouping rows in React (server does it; the grid renders what it is given).
- Computing totals or roll-ups in the browser (`/query` returns `totals`; `rollup_cache` serves the tree).
- Letting a Sheet or CSV write budgets (Sheets/CSV/manual entry only ever produce *facts* or *drafts* that go through approval).
- Sending Slack or email from an API request handler (write an outbox row; a worker delivers).
- Adding an MCP tool that mutates "just for testing".
- Calling OpenAI outside `@budget/ai`.
- Filtering at scale through the `dimension_values` jsonb mirror (use `envelope_dimension`).
- Installing any `@svar/*` PRO package or any commercial grid because "the free one lacks X" (implement X in the adapter, per plan §3.9).
- A `disabled` button with no `reason`.
- Applying pasted cells directly into the grid (paste always opens the bulk preview).

## 10. When you are stuck

1. Re-read the task's "Done when". Implement only that.
2. Look for the answer in the spec section the task cites, then §4 of this file.
3. Search `docs/adr/` for a prior decision.
4. Still blocked: open the PR as **Draft** with a `## Blocked` section stating the question and your proposed default. Do not guess silently on data model, permissions, money or licensing.
