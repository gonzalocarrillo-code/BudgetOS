# ADR-009: Targets, the metric library and KPI roll-ups

## Status

Accepted.

## Context

T-015 (spec §10, §6.2) needs a CPA at every roll-up level that equals spend divided by conversions. Before T-015, the spec §6.2 code built one `kpi_<metric>` ratio per envelope and grouped queries dropped it. A ratio of ratios can't be rolled up: the mean of leaf CPAs is not the group's CPA.

The spec is also silent on a few points this task has to settle:

- how CPM gets its ×1000;
- who may write a filter-scoped target;
- where the drawer reads the implied volume;
- what a grouped row shows for a target.

## Decision

- **Roll-ups divide sums.**
  - The planner's `m` CTE carries `num_<metric>` and `den_<metric>` per envelope.
  - `m2` derives the per-envelope `kpi_<metric>`.
  - Grouped rows and `compileTotals` compute `sum(num) × multiplier / NULLIF(sum(den), 0)`.
  - A group with no conversions is `NULL`, never 0 or infinite.
  - Spend on an envelope with no KPI rows still counts in the numerator.
- **Metric library.**
  - `metric_definition` is org-level and seeded with plan §4.8's defaults: budget, CPA, CPL, CPM, CPC, CTR, ROAS, conversions, revenue, impressions and reach.
  - New migration `20260924060000_metric_multiplier` adds `multiplier numeric NOT NULL DEFAULT 1 CHECK (> 0)`. The planner applies it after the division, so CPM = Σspend / Σimpressions × 1000.
  - The planner reads the library from `CompileOptions.metrics`. The API loads it with `plannerOptions()`. The process-wide `metricRegistry` stays as the default for tests and benches.
  - `GET/POST /workspaces/:ws/metrics` sits in the registry module (spec §17). Only an org admin writes it, which matches the RLS policy.
- **Target resolution per row.**
  - Every flat row gets:
    - `tgt_<metric>`: `effective_target()`, which is the envelope's own target, else the nearest ancestor's;
    - otherwise, the first matching filter-scoped target;
    - `vs_<metric>` = actual / target, the same ratio as the filter's `vs_target_pct`.
  - The filter's `target.*` predicates use the same resolution.
  - Filter-scoped targets are compiled into a `CASE` from the target's `ScopeFilter`, most specific first (most predicates), then newest.
  - Grouped rows carry the rolled-up KPI but no target. A group has no single target unless one is defined for exactly that group, and the spec doesn't define group targets.
- **Targets follow the envelope rules.**
  - A change is a new `target_version`. A stale `basedOnVersionId` is a 409 with `currentVersionId`.
  - Submit matches policies with `entityType: target_version`, `metricKey` and `deltaPct`.
  - The approval engine (decide, withdraw, request changes, external evidence, the inbox) handles `target_version` requests. The scope checked is the envelope's dimensions.
- **Filter-scoped targets need a workspace-wide role**, both to write and to approve. Checking that a filter lies inside a scoped role's filter is a containment problem the scope model doesn't solve.
- **Target values are in the workspace reporting currency** for currency metrics, because KPIs are computed over reporting-currency facts.
- **`GET /envelopes/:id/targets`** is a route that spec §17 doesn't list. It returns the effective target per metric (own, inherited or filter) and the implied volume for cost-per metrics, computed as `budget × multiplier / target` at read time.

## Consequences

- Filters, the grid, the timeline, alerts, MCP and pacing all get the same KPI numbers at every level, from the planner.
- The compile bench does more work per grouped query with `targets[]`, because the roll-up is now emitted. It stays inside ADR-006's 10% gate.
- Reach is summed across envelopes, so its roll-up is an upper bound. Deduplicated reach needs person-level data.
- Still open:
  - targets for a group row;
  - FX for targets in another currency;
  - `POST /workspaces/:ws/targets/import` (spec §17: Sheet range or CSV), which belongs with the ingestion connectors (T-017).
