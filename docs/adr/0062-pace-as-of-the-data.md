# ADR-062: Home and the Overview read pace as of the data

## Status

Accepted. Amends the inputs of ADR-047 for Home and the Overview; the formula is unchanged.

## Context

ADR-047 defines pace as spend against the budget's share of the period, over the share of the period gone. The share gone is counted to today.

Actuals arrive late:

- The golden's facts are monthly. Their source maps the date column as `yyyy-MM`, so each month is one row dated the first of the month.
- On 29 September the latest rows are August's. Counted to today, 75% of the year has gone, but the actuals cover 67% of it.
- The Overview read a pace of 0.79 and Home 0.63. Through 31 August the leaves' pace is about 0.88.
- The Overview said "Actuals through 2026-08-01": the first day of the last month, not the last day the actuals cover.

The plan's decisions G2 (count time gone as of the data) and G7 (when data is stale) proposed the fix. See `docs/HOME_OVERVIEW_PLAN.md` §2.1, B-1.

## Decision

**Coverage.** `dataAsOf` in `@budget/db` finds the latest spend fact's date and the sources that loaded that date.

- When every one of those sources maps its date as `yyyy-MM`, the facts cover the whole month, so `through` is the month's last day.
- Otherwise `through` is the date itself. Facts with no source run (manual entry) count by day.
- `through` is never later than today. A month loaded while it is still running covers up to today.

**Stale** (decision G7):

- A daily source is stale when it is more than 2 days behind today.
- A monthly source is stale when last month is still missing 10 days after it ended.

**Planner.** `CompileOptions.elapsedThrough` counts time gone through that day when it is before today.

- Only the share gone changes, so only pace (and the measures derived from time gone) move.
- Filters and relative periods keep today.
- Both the Postgres and the BigQuery dialects read it.
- The query cache key includes it, so a today-based answer is never served in its place.

**Where it applies.** Home (header totals and the strip per budget) and the Overview (every planner query) resolve the workspace's coverage once and pass it. `/query`, Budgets, the roll-up cache, pacing rules, the timeline and the MCP still count to today.

**What people see.**

- An as-of chip in both headers: "Actuals through 31 Aug 2026". Once stale it turns to the warning tone and adds the age.
- The Overview shows a banner while the actuals are stale.
- On the Overview, `period.elapsed` is the share of the period gone by the covered day; `period.elapsedToday` is the calendar share. Home returns the same share in `asOf.elapsed`.

## Consequences

- While actuals lag, Budgets' pace column and the Overview can differ for the same budget. The Overview labels its pace with the day it is read at.
- A follow-up can offer the option on `/query` as a request field, so Budgets and pacing rules use it too. Pacing rules would then stop raising under-pace alerts for data that is only late.
- A monthly feed stored with a daily date format reads as daily, because its mapping says so.
