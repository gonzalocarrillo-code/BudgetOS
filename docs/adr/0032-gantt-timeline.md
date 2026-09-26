# ADR-032: The Gantt timeline (GET /timeline and BudgetTimeline)

## Status

Accepted.

## Context

T-037 (spec §23, plan §4.11 and §11.9) builds three pieces:

- `GET /workspaces/:ws/timeline`, which returns `TimelineResponse`;
- `BudgetTimeline` in `@budget/timeline`, on the SVAR React Gantt MIT core chosen in ADR-003;
- `view=timeline` in the Explorer.

The done-when:

- 5,000 bars render in under 500 ms p95.
- Targets appear as lanes, with the correct effective target on each date.
- An as-of redraw matches `/query?asOf`.
- No `@svar/*` or PRO import gets in; eslint and license-check both enforce it.

The spec leaves open how a date picks the effective target, how the parts are paged, and where markers come from.

This timeline is not the decision timeline of T-012 (`GET /envelopes/:id/timeline`). The two keep separate code and tests (LOCAL_BUILD_PHASES finding 4).

## Decision

**Endpoint.** It is built on the planner, so it matches `/query` by construction.

- It uses the same `FilterGroup`, sent as lz-string or JSON.
- The caller's read scope is ANDed in with `scopedQuery`, and only live leaves are read (ADR-016).
- Group bars are `compileQuery` at `grain='total'` for each prefix of the grouping path. The path is `groupBy`, else the hierarchy template's path.
- A new planner option, `groupDates`, adds `min(start_date)` and `max(end_date)` to grouped rows. That option is off for every other caller.
- Envelope bars are the flat query, keyset-paged by name with `cursor` and `limit` (at most 5,000).
- Group bars come with the first page only. The web view loads pages of 2,000 until it has 5,000 envelopes, then says the list is truncated.
- Budgets use the planner's `asOf`, which is the latest version approved by then. The as-of redraw is therefore the same SQL as `/query?asOf`.
- The range is `from`/`to`, else `period` (a preset or PeriodSpec as on `/pacing`, resolved on the workspace's fiscal calendar), else the current fiscal year. `period` is an addition to the spec's parameters, because the web does not know the fiscal start month.
- The response carries an `X-Data-Version` header.

**Target lanes and the effective target per date.** Plan §4.11 says overlapping targets stack as lanes, and the effective one at any date is the most specific.

- Each envelope row carries the envelope-scoped targets of the envelope and of its ancestors (caps). Only targets overlapping `[from, to]` are included, each with the value current at `asOf`.
- Per date, the most specific target is chosen in this order:
  1. the envelope's own target over an inherited one (as `effective_target()` walks up the parents);
  2. then the shortest date range;
  3. then the latest start.
- `TimelineBar` gains fields on top of the spec's shape:
  - `value` and `comparator`;
  - `inheritedFrom`, the ancestor envelope;
  - `effective`, the date ranges on which that target is the one in force.
- `stackLanes` assigns lanes per metric.
- The helpers (`effectiveTargetAt`, `effectiveSegments`, `stackLanes`) are pure and live in `@budget/domain/timeline.ts`. The API builds the response with them, and tests check each date against them.
- `/query` still uses `effective_target()`, which has no date. On a leaf whose own target covers only Q4, `/query` shows that target for the whole period. The timeline shows the inherited annual target before Q4. Adding a date to `effective_target()` is left for a later ADR.

**Markers and key dates.** They are read in `packages/db/src/gantt.ts`, dated in UTC, on or before `asOf`, and within the range:

- approval requests on the envelope's versions, at their decision, else their request;
- versions approved without a request;
- alerts opened;
- threads on the envelope.

Period closures are calendar key dates: a vertical line on the day of the close. There is no holiday or client key-date table yet, so those kinds are empty. Experiment bars arrive with T-038, the first task with an experiment table.

**BudgetTimeline.**

- Tasks: `toSvarTasks` maps bars to SVAR tasks.
  - A collapsed envelope passes only its `budget`-metric target rows, and is `lazy` when it has others.
  - Opening it answers SVAR's `request-data` from the lanes already in `data`.
  - `open` is set only on tasks whose children are passed (ADR-003).
- Scales: the scales are fiscal (`fiscalScales`).
  - SVAR's `year` and `quarter` are calendar units, so fiscal years not starting in January get a unit registered with `registerScaleUnit` (`fy{m}`). Quarters not starting in Jan/Apr/Jul/Oct get `fq{m}`.
  - Labels come from `calendar.periods`.
  - SVAR's week cells start on Sunday (its locale). A week cell is labelled with the ISO week it shares six days with.
- Overlay: the marker overlay, today line and as-of scrubber are one layer portalled into SVAR's scrolled chart area.
  - Each is positioned the way the store places bars: `diff(date, scale start, lengthUnit) × cellWidth`, with the row's `$y`.
  - Markers under 6 px apart on a row cluster.
  - The scrubber commits on release as the end of that UTC day, and dropping it on today clears `asOf`. It also moves by keyboard: ←/→ a day, Shift a week, Home, End.
- The component is read-only in Phase 1. Drag editing is epic 2.5.
- The grid's third column is "Spent" (% of budget, with a pace-coloured dot), not the pace index. The product owner asked for % spent (see the Overview feedback).

**Licence guard.** `scripts/forbidden-packages.mjs` lists the commercial packages: SVAR PRO, AG Grid, Bryntum, Syncfusion, MUI X Pro/Premium and TipTap Pro.

- Root eslint (`no-restricted-imports`) refuses importing them.
- `license-check` refuses any of them in the production tree, whatever licence string it carries.
- For SVAR, `pro` must be a whole name segment. `@svar-ui/*-data-provider` is MIT and allowed.

**Benchmark.** `bench/render-budget.tsx` mounts `BudgetTimeline` itself in headless Chrome with 5,000 bars: 20 groups, 996 envelopes and 3,984 budget lanes, with markers. Each sample is a full remount, timed until the bars and the overlay are painted.

- The bench fails at ≥ 500 ms p95 in absolute terms.
- It also fails when it regresses by more than 10% against `baseline.json`, calibrated by CPU scale.
- Recorded on this machine: 100.8 ms p95 at `cpuScaleMs` 17.8, which is 79.2 at the file's 13.991. Panning ran at 59.9 fps p50.

## Consequences

- The timeline, the tree and `/query` agree on budgets as of any instant, because they run the same planner SQL.
- Per-date target resolution exists only on the timeline until `effective_target()` takes a date.
- SVAR drops the chart below its compact-mode width (the grid only). The timeline needs a desktop-width window.
- The Explorer's `RowSource` cache is not shared with the timeline. The timeline has its own TanStack Query cache, keyed by the same search params, so switching tree ↔ timeline refetches neither once each has loaded.
