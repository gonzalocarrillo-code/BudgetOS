# ADR-057: What the MCP server tells an AI

## Status

Accepted (product feedback round 8, docs/DATA_PLAN.md §7, tasks D-010 to D-012).

## Context

The owner wants an AI orchestrator to answer questions about channels, budgets, tCPA, totals, hierarchies and countries well. The read-only tools already reached all of that, but an orchestrator had to make four or five calls before it knew what "channel" meant in a workspace, which metric was called tCPA, what the fiscal year was, and what the headline numbers were.

## Decision

- **Handshake instructions.** The server sends `instructions`: call `describe_workspace` first; how FilterGroup, granularity keys and codes work; how to count leaves once and read the workspace's budget; that amounts are reporting-currency strings; that ratios come from counts and are never summed; where history lives; which prompts exist.
- **`describe_workspace`, one call for the picture.** It returns:
  - the calendar (fiscal year, this quarter);
  - every granularity with its value count, how many budgets and values use it, the fiscal year's budget by value for the ten granularities in most use (top eight values), and the words people use for it;
  - the hierarchies;
  - the metric library with formulas, ratio flags and synonyms (tCPA is CPA);
  - the headline, built by the same `headline()` Overview and Home use;
  - counts, snapshots, closes, freshness, and hints for building `query_budgets` calls.
  It is built from existing reads, under the caller's scope.
- **A glossary resource** (`budget://workspace/{id}/glossary`) lists granularities, metrics, ratio words, statuses and concepts. The mapping synonyms (ADR-055) feed it, so a word learned from a client's file is a word the AI knows.
- **Described fields.** `query_budgets`' filter, groupBy, measures, targets, period, compareTo and subtree say where their keys come from. Tool registration is static, so descriptions cannot list one workspace's keys; `describe_workspace` carries those.
- **Prompts.** `pacing_review`, `since_snapshot` and `unmatched_spend` read their numbers live through the same authentication, permission, rate limit and audit as a tool (`mcp.prompt.<name>`), and return one user message: what to explain, then the data.
- Read-only is unchanged. Everything reaches the server through the API's read barrel. `sourceView` moved to the queries side so the unmatched-spend read does not import a command, and the import guard still passes.

## Consequences

- An orchestrator that follows the instructions answers "what channels do we have and how are they pacing" in two calls.
- `describe_workspace` runs up to eleven planner queries; it is an orientation call, not one to loop on.
