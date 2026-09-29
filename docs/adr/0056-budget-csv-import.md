# ADR-056: Importing budgets from a CSV

## Status

Accepted (product feedback round 8, docs/DATA_PLAN.md §3, tasks D-007 to D-009). Decisions F4 and F5 follow the plan's proposals.

## Context

A CSV could only edit budgets that already existed, by id and amount. Nothing created budgets or a tree from a file, and nobody knew which columns a file needed.

## Decision

- **The template is the workspace's own.** `GET /workspaces/:ws/budget-import/template` writes one column per active granularity with values, ordered by the chosen hierarchy template, then `key`, `parent_key`, `name`, `currency`, `amount`, `start_date`, `end_date`, one column per month of the current fiscal year (phasing), `envelope_id` and `rationale`. A first row starting with `#` explains the rules, and two live budgets are examples: they keep their `envelope_id`, so re-importing them unchanged changes nothing.
- **Rows are read against the registry.** Headers match granularity keys or labels. Values resolve by code, alias, external id, then label; an unknown value fails its line with the nearest code by code, label or alias. Amounts are plain numbers; a comma is accepted only as a thousands separator, never as a decimal mark. Months must add up to the amount. Tuples must satisfy the registry's value constraints.
- **Which budget a row is.** A row with `envelope_id`, or whose granularities and dates are a live budget's, edits it: `change` when the amount differs, `same` when not. Any other row is `new`. An ended budget, a closed period, a duplicate line or a budget outside the caller's scope is an error on that line (F4: planners import within their scope).
- **Parents.** `parent_key` places a row under another row's `key` or a budget id. Otherwise each shorter prefix of the row's granularities, in the hierarchy's order, is a parent: a live budget with exactly that tuple covering the row's dates, or a new one the import creates, holding the sum of what the import puts under it (valid rows only), spanning their dates, in one currency. An existing parent the import would push over its budget blocks Commit.
- **Preview, then commit.** The preview writes nothing and keeps the file for 30 minutes. The commit rebuilds the plan in its own transaction, so budgets that moved since the preview are re-checked, and writes new budgets (parents first), their drafts and the changed budgets' drafts as one bulk change of kind `import`, routed through the approval policy like a paste or a split. Rejected, its new budgets are archived. One audit event per budget created or changed, one `budgets.imported` summary, one outbox row.
- **Registry values are not created by the import** (F5); an admin adds a missing value in the Registry and previews again.

## Consequences

- The same file imported twice changes nothing.
- A file only ever produces drafts; nothing it holds is a budget until it is approved.
