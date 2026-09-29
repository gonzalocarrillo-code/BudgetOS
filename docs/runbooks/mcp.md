# Read-only MCP server (T-025, ADR-019)

## Run locally

```
MCP_DATABASE_URL=postgresql://budget_mcp:replace-in-secret-manager@localhost:5434/budget \
AUTH_AUDIENCE=<identity platform project> pnpm --filter @budget/mcp dev
```

`POST http://localhost:8080/mcp` takes a Bearer token (Identity Platform JWT).
- Instructions: sent at the handshake (`INSTRUCTIONS` in `apps/mcp/src/server.ts`). They tell an orchestrator to call `describe_workspace` first, and how filters, amounts and ratios work.
- Tools: `list_workspaces`, `describe_workspace`, `describe_dimensions`, `query_budgets`, `get_budget`, `get_pacing`, `query_targets`, `search`, `list_approvals`, `get_decision_timeline`, `list_alerts`, `list_threads`, `list_tags`, `get_closure`, `list_baselines`, `get_baseline`, `compare_budgets`, `export_csv`.
- Resources: `budget://workspace/<id>/registry`, `budget://workspace/<id>/glossary` (the workspace's words, fed by the mapping synonyms).
- Prompts: `pacing_review`, `since_snapshot`, `unmatched_spend`. Each reads its numbers live under the caller's scope and is audited as `mcp.prompt.<name>`.

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
