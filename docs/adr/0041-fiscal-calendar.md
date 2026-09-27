# ADR-041: The workspace's own fiscal calendar

## Status

Accepted.

## Context

Product feedback (2026-09-26): "what a quarter is, the partitions, the views, and ending or reopening a quarter should be very dynamic."

Periods were a fixed rule (`resolvePeriod`): calendar months, and quarters of three months from the workspace's fiscal-year start month. That had several gaps:

- There was no 4-4-5 calendar and no custom partition (a campaign window).
- The fiscal-year start could not be changed after the workspace was created.
- The Explorer offered only relative presets.
- Closing or reopening a period was only possible from the closures screen, by key.

`fiscal_period` rows existed, but only closures created them.

## Decision

- **The calendar is rows.** A workspace's `fiscal_period` rows are its years, quarters and months (calendar months, or 4-4-5 / 4-5-4 / 5-4-4 weeks) and custom partitions.
  - `resolvePeriod(spec, today, startMonth, calendar)` prefers them: a fiscal key resolves to its row, and "this month / quarter / year" (and YTD) to the row of that kind containing today.
  - With no row, the old rule applies, so a workspace that never defines a calendar behaves as before.
  - Every resolver passes `fiscalCalendar(tx, ws)`: the Explorer (`/query`, `/tree`), the timeline, Home, exports and the export worker, pacing (API and worker), the roll-up worker's cached periods, and search facets. Closing a period by key still creates the row when none exists.
- **Generating a year** (`fiscalYearPeriods`) keys periods as `resolvePeriod` reads them:
  - `FY2027`;
  - `2027-Q1`…`Q4`;
  - calendar months (`2027-07`), or fiscal months `FY2027-P01`…`P12` for week patterns.

  Week-based quarters are 13 weeks from the first day of the start month; the last one runs to the end of the fiscal year. Existing keys with the same dates are kept. A key that exists with other dates refuses the whole generation, naming the periods, because a mixed year would have gaps or overlaps.
- **Rules on periods:**
  - Two periods of the same kind (other than custom) may not overlap, so "this quarter" is always one row.
  - A period with a closure keeps its dates (its report was frozen on them) and cannot be deleted.
  - A period that budgets are aligned to cannot be deleted either.
  - Writes need `registry.manage` and emit `audit_event` + `outbox` (`period.changed`).
- **The fiscal-year start** is settable: `GET`/`PATCH /workspaces/:ws/fiscal-year`, audited. It emits `registry.changed`, so roll-ups rebuild.
- **UI:**
  - **Admin › Fiscal calendar:** start month; create a year's periods in a pattern; custom periods; each period with its closure state and Close (once it has ended) or Reopen (restate, with a reason); delete when allowed.
  - **Explorer period picker:** lists the workspace's periods (years, quarters, custom) next to the relative presets.
  - **Settings search:** gains "Fiscal calendar".

## Consequences

- Finance can run a 4-4-5 year, and "this quarter" in the grid, the roll-up cache, pacing and exports means that quarter.
- Changing a period's dates changes what every open screen shows for it. A closed period is the stable record.
- **Tests:**
  - `domain/calendar.test.ts`: patterns and resolution.
  - `periods/periods.test.ts`: the routes, a 4-4-5 "this quarter" through a real query, and the rules.
  - `e2e/periods.spec.ts`.
