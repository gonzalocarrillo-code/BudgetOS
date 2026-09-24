# ADR-012: Pacing evaluator — period, streaks, one open alert

## Status

Accepted.

## Context

T-018 (spec §11, plan §8.4) evaluates pacing rules every 15 minutes and opens alerts. The done-when is a consecutive-days test and no duplicate open alerts. Several points needed a decision:

- **Period.** The spec's `evaluateWorkspace` queries `current_quarter`. The planner's `budget` measure is the envelope's whole amount (golden envelopes are annual), so a quarter's spend against a year's budget would read as heavily under-paced.
- **Streaks.** The spec code counts a day when `last_eval_date` is yesterday, and otherwise starts at 1. A same-day re-run every 15 minutes would reset the streak to 1. Using only a last-result flag would lose yesterday's streak after an unbreached run earlier in the day.
- **Duplicates.** "No duplicate open alerts" can't rest on a read-then-insert when two job runs overlap.
- **Org discovery.** RLS keeps `organization` closed to `budget_app`, so the job can't find the orgs to evaluate.

## Decision

- **Period:** `metricArgs.period` (a `PeriodSpec`) with default `current_year`, the fiscal year of the workspace. Relative and fiscal periods resolve through the new `resolvePeriod` in `@budget/domain`, which follows `workspace.fiscal_year_start_month`. Archived envelopes are skipped. `metricArgs.daysRemainingLt` adds `end_date ∈ [today, today + N)`.
- **Streaks:** `rule_state.prior_days` (migration `20260924090000_pacing`) holds the streak through the day before `last_eval_date`.
  - The streak through yesterday is `prior_days` if `last_eval_date` is today, `consecutive_days` if it was yesterday, and 0 otherwise.
  - Today's count is that plus 1 when the rule breaches, else 0.
  - Re-runs on the same day recompute today and never grow the count.
- **One open alert:** partial unique index `alert_one_open_per_rule_envelope ON alert (rule_id, envelope_id) WHERE status IN ('OPEN','ACKNOWLEDGED','SNOOZED')`. The evaluator inserts with `ON CONFLICT … DO NOTHING` (`openAlert` in `@budget/db`), so concurrent evaluators open one alert between them.
- **Lifecycle:**
  - An alert opens once breached with `consecutive ≥ consecutive_days` and nothing is open.
  - It resolves when no longer breached, unless it is snoozed.
  - A snoozed alert reopens once `snoozed_until` has passed and the rule still breaches.
  - Every transition writes one `audit_event` and one outbox row: `alert.triggered` on open and reopen, `alert.changed` on resolve and on user changes. `rule_state` is bookkeeping and isn't audited.
  - A user can acknowledge, snooze (only to a future time) or resolve an alert, or change its owner. Resolved is final.
- **Metrics without inputs are skipped:**
  - No projection facts means `projected = 0`, so projection-based metrics are null rather than a false "0 % projected close".
  - KPI metrics need a target and a non-zero denominator.
- **Who writes rules:** only a workspace-wide `rule.manage` role (same reasoning as filter-scoped targets in ADR-009).
- **Who changes alerts:** `envelope.edit_draft` in the alert envelope's scope. Listing needs `envelope.read`, and alerts outside the caller's scope are dropped.
- **Org discovery:** the job (`apps/workers/src/pacing/main.ts`) takes `PACING_ORG_IDS` from its scheduler, like `escalateOverdue`. It lists each org's workspaces with the org-scoped admin bypass.
- **Planner options** (`plannerOptions`: metric library and filter-scoped targets) moved to `@budget/db` so the worker and the API load them the same way.

## Consequences

- Default rules (plan §8.4) are seeded per workspace by `seedDefaultRules`.
- Still open:
  - **"Unmatched spend > 2 %" (data) is not shipped.** It is a workspace-level alert, and `alert.envelope_id` and `rule_state` are keyed by envelope. It waits for the data-quality screen (T-032).
  - **Pacing on sub-periods** such as a quarter against its share of the budget needs phasing-aware budgets in the planner.
  - **`escalateOverdue`** lives in the API and is not called by the job yet.
- The Cloud Scheduler trigger (`*/15 * * * *`) and the job's service account come in phase 20.
