# ADR-022: The Explorer on /query: tree and pivot row sources, edits, paste

## Status

Accepted.

## Context

T-027 (spec §18.2–18.3) wires `@budget/grid` to `POST /workspaces/:ws/query`: filter bar, saved views, drawer, inline edit, and paste into the bulk preview. The done-when:
- filter → URL → reload;
- the inline edit conflict flow;
- pivot totals equal tree totals.

## Decision

- **API:**
  - `POST /workspaces/:ws/query` (`envelope.read`) is `runQuery` (ADR-019): the caller's read scope ANDed in, one page, the totals and the data version.
  - Flat rows now carry **`versionId`** (the draft, else the current version; the planner selects it), which an inline edit sends as `basedOnVersionId`.
  - Saved views: `GET`/`POST /workspaces/:ws/saved-views`, `PATCH`/`DELETE /saved-views/:id`:
    - private to their owner;
    - `visibility: "workspace"` needs `view.share_workspace`;
    - each write is one audit_event plus one `view.changed` outbox row.
    - A view is a bookmark, so DELETE removes it; its audit row keeps what it was.
  - The hierarchy-template list now returns ids.
- **Rows are live leaves everywhere.** Every Explorer query ANDs `LIVE_LEAVES` (moved to `@budget/domain`; ADR-016). So the tree, the pivot and the totals row sum the same envelopes, and a parent (a cap) never counts twice. Pivot totals equal tree totals by construction; the e2e test also sums the pivot's rows.
- **The tree:**
  - one level per hierarchy-template key (the default template, or `templateId`);
  - a node's children are the next level's groups under its prefix (eq, or is_empty for "none"); below the last key, the envelopes;
  - expanded keys live in the URL (`expanded`).
  - Levels are fetched whole, which suits the small golden; paging per level at 100k leaves is T-034's measurement.
  - `rollup_cache` (`compileTree`) is not used yet: the tree is live, so any period works. The cache is an optimisation to switch on when T-034 shows the need.
- **Pivot:** the groups of the chosen `groupBy` keys, or the envelopes themselves when none is chosen. A crosstab (dimension values as columns) is not built.
- **URL:** `filter` and `expanded` are lz-string (`src/lib/search-params.ts`); the other params are JSON; defaults are stripped.
- **Inline edit:** Budget on envelope rows → `PATCH /envelopes/:id/draft` with the row's `versionId`.
  - A 409 shows the envelope's current value (draft, else approved) and a "Reload rows" action. Nothing is overwritten.
  - Success writes a draft (approval unchanged) and says so.
- **Paste:** a pasted range never writes cells. Its Budget column becomes a bulk `paste` preview (T-013) in a dialog (before, after, change, totals, caps, policy), and only Commit writes drafts.
- **Drawer:** a sheet over the grid, opened from a row's name cell. It shows the approved budget, the draft, dates and dimensions.
- **`@budget/grid` fixes found on real data:**
  - The row cache was disposed by React StrictMode's effect replay and then ignored every page (blank grid). The hook now recreates it.
  - `getCellContent` now changes with the cache version, so the canvas redraws when rows arrive.
  - Glide stores selection only without `onGridSelectionChange`, so `BudgetGrid` holds the selection itself. Without that nothing selected or edited.
  - Editors select their text when opened by double-click or Enter.
  - Additive changes: column `title`/`width`, a `theme` prop, the totals row on the column widths, `onOpen`.
  - The app's `index.html` has Glide's `#portal`.

## Consequences

- Filter-bar scope: dimension `in` chips and removal. The nested AST editor (`<FilterTree/>`) and `<PeriodPicker/>` ranges and as-of are later work; period presets are selectable.
- The Explorer does not show a row's draft amount in the grid (the Budget column is the approved budget); the drawer shows it.
