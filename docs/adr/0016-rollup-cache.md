# ADR-016: Roll-up cache and the tree read

## Status

Accepted.

## Context

T-022 (spec §19, §6; plan §5.3) adds `rollup-worker` and the planner's tree read of `rollup_cache`. The done-when is that tree totals equal pivot totals on the golden seed. Envelopes nest: a parent's approved amount is a cap over its children. A tree that summed every envelope would count budgets twice.

## Decision

- **Nodes aggregate live leaves.** A live leaf is an envelope with no non-archived child that isn't archived itself.
  - A node is a prefix of a hierarchy template's path (`LATAM/BR/meta`); the root is `''`.
  - A dimension the envelope lacks is the segment `∅`.
  - `is_leaf` is a new planner `attr` (eq true / false), so a pivot can use exactly the tree's population.
  - A node's `envelope_id` is the one non-archived envelope whose tuple is exactly that node, if there is one (the parent row the grid shows).
- **Measures come from the planner.** Each depth is one planner `groupBy` over the template path up to that depth; the root is `compileTotals`. The cache and a live pivot therefore can't disagree.
  - Stored measures: `budget`, `actual`, `projected`, `remaining` (money at 2 dp), `pace_index`, `spend_to_date_pct`, `projected_close_pct`, `leafCount`, `pendingCount`.
  - `data_version` is stamped from the workspace.
- **Incremental refresh.** On `budget.changed` and `facts.loaded`, the envelopes the event names are resolved (bulk, split and merge included). For each template and cached period, only the prefixes of those envelopes' tuples are recomputed, one planner query per depth. Prefixes that come back empty are deleted.
- **Full rebuilds.** `registry.changed` (merged values, saved templates) rebuilds every template. A rebuild also drops nodes no longer present.
- **Periods:** the workspace's current fiscal year plus every period already cached, and any extra period the caller passes; the golden seed passes FY2026.
- **Tree read.** `compileTree` (`@budget/query-planner`) reads a template and period in depth-first order, `ORDER BY string_to_array(node_path, '/') COLLATE "C"`, with each row's depth. `parentPath` gives lazy child loading. It never aggregates.

## Consequences

- The `/query` endpoint that routes `templateId` requests to `compileTree`, with a live-pivot fallback for uncached periods, comes with the Explorer wiring (T-027). `compileQuery` still refuses `templateId`.
- `openAlerts` and `openThreads` per node are not cached: the planner computes them for flat rows only.
- Dimension codes containing `/` would break the path. Registry codes are slug-like today.
