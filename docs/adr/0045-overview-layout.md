# ADR-045: Overview layout per person, and editing from the heatmap

## Status

Accepted.

## Context

Product feedback (2026-09-28) asked for two things on the Overview:

- **"Edit everything in overview"**, which the product owner chose to mean editing the budgets behind a heatmap cell.
- **"What we see and what we don't see"**, meaning each person chooses which tiles and panels show.

The rules forbid `localStorage` for data (AGENTS.md §4), so the choice needs a server home. Every write also needs an audit event and an outbox row.

## Decision

- **Layout.** The layout is a private saved view with `screen = "overview"` and `definition = { hidden: [section keys] }`.
  - Saved views already provide per-person privacy, workspace sharing, audit and outbox (`view.changed`) and an API.
  - A view the workspace shares is the default for anyone who has not saved their own.
  - The only schema change is `overview` added to `SavedViewScreen`.
  - The page applies a change immediately and saves in the background. Saves run one after another (a mutation scope), and each looks up the person's view fresh, so quick toggles never create two views.
- **Editing.** A heatmap cell opens a side drawer. It reuses the existing write paths; there are no new endpoints.
  - Each budget takes a new amount through `PATCH /envelopes/:id/draft`, then Send for approval, as in Budgets.
  - The whole cell changes by a percentage through `POST /envelopes/bulk` with a filter selection and `op: pct`. That opens the bulk preview, and nothing is written until Commit, so the approval policy applies.
  - The drawer keeps a link to the same budgets in the Explorer pivot.
- **Periods.** `GET /overview?period` also takes `fiscal:<key>`, like the Explorer's period picker. An unknown key is a 422.

## Consequences

- Admins can set a team default by sharing their Overview layout, from the saved-views API; there is no UI for this yet.
- A new tile or panel needs a section key and a label (`overview.section.*`).
