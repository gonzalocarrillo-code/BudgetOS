# ADR-029: The Overview dashboard in one server call; pace, not projection, for "variances"

## Status

Accepted.

## Context

T-033 (spec §18.5, plan §11.1, Epic 1.11) asks for:
- a pacing heatmap (market × platform);
- the top variances;
- KPI against target;
- open alerts, approvals due and data freshness.

It must render in under 1.5 s with zero configuration, and the rules forbid totals or roll-ups in the browser.

## Decision

- **`GET /workspaces/:ws/overview?period`** (`envelope.read`, a relative preset, default `current_year`) returns every widget in one round trip.
  - Each number comes from the planner through `runQuery`, cut to the caller's read scope and summed over live leaves (ADR-016), so it equals the Explorer's totals.
  - The queries run in parallel; the golden workspace answers in about 0.1 s on the server.
- **Heatmap:**
  - the registry's `country` × `platform` (falling back to `market` / `region` × `channel`), grouped over live leaves, by budget;
  - top 12 markets × 8 platforms, with value labels;
  - each cell shows its pace index and budget, is coloured in five pace bands (the legend uses the same thresholds), has an accessible name with the numbers, and opens those budgets in the Explorer pivot, filtered.
- **"Top variances" are over and under pace:** the five budgets with the highest pace index above 1 and the lowest below 1, with spend against budget.
  - Pace compares spend so far with the phased plan, so it is meaningful from the first day of actuals.
  - Projected variance needs projection facts, which a workspace may not load (the golden has none, so every projection reads 0).
  - The planner's `variance_abs` stays available to reports.
- **KPI vs target (CPA) by market:**
  - the actual comes from the market's live leaves, grouped;
  - the target is the effective target on the market-level budget (a market set, no platform), where targets are set;
  - the server computes the gap (actual ÷ target − 1; lower is better).
  - A grouped planner row carries no single target, because targets live on envelopes.
- **Alerts:** open counts by severity and the five newest, by name (the `/alerts` query).
- **Approvals:** what the caller may decide now (`assignee=me`), overdue count, and the five soonest due.
- **Freshness:** the latest fact date, and each source's last run (status, time, spend matched), without needing `source.manage`.
- **Projections only when there are some:** the planner's `projected` measures cost about 0.5 s on the golden workspace even with no projection facts. The overview runs a small projection-totals query only when the workspace has projection facts; otherwise the tile shows "—" ("no projections loaded"). This takes the endpoint from about 580 ms to about 95 ms. Making the planner's projection measures cheap is a separate follow-up.
- **Timing:** the Playwright check first loads the route (a first visit in dev mode is 1.1–1.6 s, mostly Vite compiling unbundled modules, which a production bundle has already). It then times a period that has not been fetched: from asking for it to every widget rendered, about 0.85 s locally. The API test asserts the endpoint answers in under 1.5 s (about 0.1 s).

## Consequences

- One route (permission-matrix row); OpenAPI and the web client regenerated.
- The Overview is one query for the browser (30 s stale time), with the period in the URL.
