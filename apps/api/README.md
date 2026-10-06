# @budget/api — NestJS REST API

The main application server. Implements spec §17 (HTTP routes, idempotency), §9 (approvals), §7 (envelopes), §14 (ingestion connectors), §15 (closures), and §26 (manual result entry).

## Running tests

```bash
pnpm --filter @budget/api test
```

Tests require a Postgres database (run `pnpm db:migrate` first on a fresh database). The test suite covers all 182 API routes, with a permission matrix that verifies each role's access.

## Architecture

- `src/common/` — shared infrastructure (auth, tenancy, error handling)
- `src/modules/` — one NestJS module per aggregate (envelopes, approvals, registry, etc.)
- `src/modules/*/commands/` — write operations (always emit audit + outbox in the same transaction)
- `src/modules/*/queries/` — read operations
- `src/serve-web.ts` — the SPA is served from here behind IAP

See AGENTS.md §4 for non-negotiables: every write emits audit+outbox; SQL goes only in `@budget/db`; errors are `DomainError`; money is `Decimal`.
