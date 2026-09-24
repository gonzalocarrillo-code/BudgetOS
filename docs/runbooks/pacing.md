# Runbook: pacing and alerts (T-018, ADR-012)

- **Job:** `apps/workers/src/pacing/main.ts`, with `APP_DATABASE_URL` and `PACING_ORG_IDS` (comma-separated). It evaluates every workspace of those orgs for today (UTC). A workspace that fails is logged and retried on the next run. Locally: `PACING_ORG_IDS=<org> tsx apps/workers/src/pacing/main.ts`.
- **Rules:** `GET/POST /workspaces/:ws/rules`, `PATCH /rules/:id`. Defaults come from `seedDefaultRules`. A rule reads `metricArgs.period`, which defaults to the fiscal year.
- **Streaks:** `rule_state (consecutive_days, prior_days, last_eval_date)` per rule and envelope. Re-running the job the same day doesn't change a streak. A day without a run restarts it.
- **One open alert per rule and envelope:** a unique index enforces it. To re-open a resolved alert, let the rule breach again; resolved alerts are never edited.
- **Snoozed alerts** stay quiet until `snoozed_until`. After that they reopen if the rule still breaches.
- **No projection facts** means the projection rules don't evaluate that envelope (see ADR-012).
