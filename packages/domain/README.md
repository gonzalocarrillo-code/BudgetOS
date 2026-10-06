# @budget/domain — Shared types and validation

Zod schemas, enums, FilterGroup AST, QueryRequest/Response, permissions, error types, and ID generators. Implements spec §5 (schemas) and core validation at every I/O boundary.

## Running tests

```bash
pnpm --filter @budget/domain test
```

Tests cover all zod schemas, permission matrix, filter compilation, error cases, and ID generation.

## Key exports

- `src/schemas/` — 50+ zod schemas for every API request/response
- `src/errors.ts` — `DomainError` with codes (NOT_FOUND, FORBIDDEN, CONFLICT, VALIDATION, CAP_EXCEEDED, LOCKED)
- `src/filter.ts` — FilterGroup AST, used by API, MCP, grid, timeline, and saved views
- `src/ids.ts` — UUID v7 generators for each entity type
- `src/permissions.ts` — role-based access control matrix

All external input is validated against these schemas before use. Spec code wins; changes here require an ADR.
