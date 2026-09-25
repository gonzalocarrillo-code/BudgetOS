# ADR-019: The read-only MCP server

## Status

Accepted.

## Context

T-025 (spec §16, plan §6.4) adds `apps/mcp`, an MCP server over Streamable HTTP. The done-when: every tool returns the golden numbers, and a CI guard keeps it read-only. The spec's sketch calls `q.X(tx)` from an `@budget/api-queries` path alias inside one `withTenant`. The API's queries, however, take `(prisma, auth)`, open their own tenant transaction, and apply the caller's dimension scope themselves. There is no `QueryPlannerService` and no `/query` endpoint yet (T-027).

## Decision

- **Read barrels in `@budget/api`:**
  - `@budget/api/queries` (`apps/api/src/queries.ts`) re-exports query functions only.
  - `@budget/api/auth` exports `authenticate` / `authorize` (extracted from the tenant interceptor, which now calls them), `JwtVerifier`, `AccessRepository` and `MemoryRoleCache`.
  - Tools call the queries with the caller's own `AuthContext` (actor type `mcp`), so RLS, scope and permissions are exactly the API's.
- **No `commands/` in the import graph.**
  - Query modules no longer import `commands/`. The shared read helpers moved to `targets/views.ts`, `targets/scope.ts`, `threads/views.ts`, `closures/views.ts` and `approvals/read.ts`. `listTags` moved to `threads/queries.ts`. The old modules re-export them, so the commands are unchanged.
  - New queries:
    - `runQuery`: the planner, with the read scope ANDed into the filter, totals and data version;
    - `describeRegistry`;
    - `closureByPeriod`;
    - `exportCsvLink`: the whole query written to the object store and returned as a 1-hour URL, **with no `export_job` row**, so the export tool writes nothing to the database.
- **Guard, first line (CI):** `apps/mcp/src/import-guard.test.ts` needs no database, and CI now runs it. It walks every file reachable from `apps/mcp/src` through relative imports and the two barrels, and fails on any `commands/` module. It self-tests against a service that does import commands. It also fails if MCP code takes anything but `withTenant` and `audit` from `@budget/db`.
- **Guard, second line (Postgres):** the server connects as **`budget_mcp`** (migration `20260925020000`):
  - SELECT on every table budget_app reads, except `outbox`, `processed_event` and `_prisma_migrations`;
  - INSERT on `audit_event` only;
  - no UPDATE or DELETE.
  - `readonly.test.ts` asserts the grants (a new table without `GRANT SELECT … TO budget_mcp` fails it) and that Postgres refuses writes made as budget_mcp.
- **One audit row per call:** `audit_event(actor_type='mcp', action='mcp.<tool>', entity_type='mcp_call')`, with the arguments. There's no outbox row, because a read isn't a business change.
  - **Deviation from spec §16:** the tools don't run inside one rolled-back transaction, because each query opens its own tenant transaction. Instead the golden test fingerprints every workspace table before and after all the calls (md5 of the rows) and checks that only the mcp audit rows were added.
- **Transport:** Fastify `POST /mcp`, stateless: a new `McpServer` and `StreamableHTTPServerTransport` per request, JSON responses.
  - No bearer token returns 401. The token reaches the tools as `authInfo` and each tool verifies it (a signature check, with JWKS cached).
  - `GET`/`DELETE /mcp` return 405; `GET /healthz`.
- **Rate limit:** 120 calls per minute per user, in a fixed one-minute window (Redis `INCR`/`EXPIRE`, memory without `REDIS_URL`). It refuses with `RATE_LIMITED`.
- **Tools:** the §16 list, all annotated `readOnlyHint: true`, plus the resource `budget://workspace/{id}/registry`. Results are `{ data, dataVersion, dataAsOf }`. `query_targets` takes metric / envelope / scope type (the API's target query), not a filter.

## Consequences

- Blocked, GCP: `mcp-readonly` on Cloud Run behind IAP, with an OAuth client for MCP clients, and a proof that per-user OAuth sees only that user's RLS scope in the deployed service.
- The `/query` route (T-027) should call `runQuery`.
- Each new table's migration needs `GRANT SELECT ON <table> TO budget_mcp`, or the guard fails.
