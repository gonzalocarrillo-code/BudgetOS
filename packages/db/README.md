# @budget/db — Prisma schema, migrations, RLS policies, SQL repositories

Database layer with row-level security, the tenancy wrapper `withTenant()`, audit logging, outbox pattern, and hand-written SQL functions. Implements spec §3 (tables, RLS, roles) and §4 (tenancy, audit, outbox).

## Running tests

```bash
pnpm --filter @budget/db test
```

Tests require a Postgres database. `pnpm db:migrate` applies all migrations; `pnpm db:seed` loads the golden dataset.

## Key files

- `prisma/schema.prisma` — Prisma-owned schema (enums, Prisma-only tables)
- `prisma/migrations/` — hand-written SQL migrations (expand-safe, with reverse comments)
- `src/rls*.test.ts` — guard tests for RLS enforcement and policy correctness
- `src/tenant.ts` — `withTenant(workspaceId)` wrapper sets `app.workspace_id` for the transaction
- `src/*.ts` — query and command repositories

Every write path emits exactly one `audit_event` and one `outbox` row in the same transaction. SQL strings live only here and in `@budget/query-planner`.
