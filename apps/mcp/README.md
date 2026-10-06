# @budget/mcp — Read-only MCP server

Streamable HTTP server implementing spec §16 (MCP server). Exposes budget data and commands to external AI agents through the MCP protocol.

## Running tests

```bash
pnpm --filter @budget/mcp test
```

Tests verify the MCP tools, OAuth flow, and read-only constraints. A guard test verifies that the `budget_mcp` role has `SELECT` on all readable tables and cannot mutate data.

## Architecture

- `src/main.ts` — Streamable HTTP server listening on a Cloud Run service
- `src/tools/` — MCP tools (search, query, approve, propose, etc.)
- `src/auth/` — OAuth with `budget_mcp` role, refresh-token rotation, replay protection
- No mutations except through the approve/propose/reject tools, which write audit+outbox

Tools import only from `@budget/domain` and database `queries/`, never `commands/`. A CI guard enforces this.
