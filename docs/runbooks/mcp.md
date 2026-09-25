# Read-only MCP server (T-025, ADR-019)

## Run locally

```
MCP_DATABASE_URL=postgresql://budget_mcp:replace-in-secret-manager@localhost:5434/budget \
AUTH_AUDIENCE=<identity platform project> pnpm --filter @budget/mcp dev
```

`POST http://localhost:8080/mcp` takes a Bearer token (Identity Platform JWT).
- Tools: `list_workspaces`, `describe_dimensions`, `query_budgets`, `get_budget`, `get_pacing`, `query_targets`, `search`, `list_approvals`, `get_decision_timeline`, `list_alerts`, `list_threads`, `list_tags`, `get_closure`, `export_csv`.
- Resource: `budget://workspace/<id>/registry`.

## Who did what

Every call is an audit row:

```sql
SELECT occurred_at, actor_id, action, after->'args'
FROM audit_event
WHERE actor_type = 'mcp' AND workspace_id = '<ws>'
ORDER BY occurred_at DESC
LIMIT 50;
```

## "RATE_LIMITED"

120 calls per minute per user; the window resets each minute. The shared count lives in Redis, under keys `mcp:rl:<user>:<minute>`.

## A migration added a table

Add `GRANT SELECT ON <table> TO budget_mcp;` to it. `pnpm --filter @budget/mcp test src/readonly.test.ts` fails until you do.
