# ADR-089: Experiments round 2 — filters instead of a campaign picker, metric choosers, a daily line chart

## Status

Accepted (EX-4).

## Context

EX-2 (ADR-086) gave each experiment side a choice between an `envelope` scope (the existing filter
bar over budgets) and a `fact` scope, but for `fact` it replaced the filter bar with a dedicated
dropdown that only picked a single `campaign` value from a new `GET
/workspaces/:ws/experiments/scope-values` endpoint. The owner's feedback on the deployed UI: "the new
compare by campaign is wrong, we already have filters that can be campaign. revert this UI change."
Separately: "we should be able to choose what metrics we see in 'Results from spend and KPI data'...
for graphs, day by day we should have a line graph, also choose what to see."

## Decision

1. **One filter bar per side, no campaign picker.** `CreateExperimentDialog`'s `SideScope` no longer
   offers a `fact` / `envelope` kind toggle or a campaign dropdown. Every side is the same
   `FilterBar` used on Budgets (`apps/web/src/features/explorer/filter-bar.tsx`), over the
   registry's dimensions (`campaign` is already one of them, plan §8, `defaults.registry.ts`) — not
   a special case. `GET /workspaces/:ws/experiments/scope-values`, its domain schemas
   (`ExperimentScopeValuesQuery`, `ExperimentScopeValue`) and the planner's
   `compileFactDimensionValues` are removed: nothing else used them.
2. **Fact scope is the new default.** `CreateExperimentInput.testScopeKind` /
   `controlScopeKind` default to `fact` instead of `envelope` (`packages/domain/src/experiments.ts`).
   A filter built with the Budgets filter bar only ever produces dimension `in` / `is_empty`
   predicates, which already satisfy `isFactScope`. `envelope` stays a valid, fully supported value:
   experiments created before EX-4 (and the golden fixture, which pins it explicitly in
   `apps/api/src/seed/golden.ts`) keep reading budgets exactly as they always did. The planner code
   from EX-2 (`compileFactSeries`, `compileFactTotals`, `compileFactFilter`) is unchanged — it already
   evaluates a FilterGroup against fact `dimension_values`, independent of budgets.
3. **Metric choosers live in the URL.** The experiment detail route
   (`apps/web/src/routes/w.$ws.experiments.$id.tsx`) gets a `validateSearch` with `metrics?: string[]`
   (the "Results from spend and KPI data" table's multi-select, default spend + the experiment's
   primary metric) and `chartMetric?: string` (the daily chart's own single-metric chooser, default
   the primary metric). Neither is component state nor `localStorage`. The day-by-day table
   (`DayTable`) is unchanged except it is addressed by its own spend row instead of assuming the
   table's first selected row is spend.
4. **The chart stays test vs control lines**, one metric at a time (EX-2's design): a single chooser
   with a solid test line and a dashed control line reads more clearly than one line per side per
   metric for more than one metric at once, and gaps already mark no-data days.

## Consequences

- One fewer endpoint, one fewer domain schema pair, one fewer planner export; `compile-fact-scope.ts`
  keeps only what `sideSeries` actually uses.
- A pre-EX-4 experiment stored with `testScopeKind: 'envelope'` is untouched and keeps resolving its
  scope through the planner over envelopes, per ADR-086.
