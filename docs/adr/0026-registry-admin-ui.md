# ADR-026: Registry admin UI — granularities with icons, value trees, hierarchies, metrics

## Status

Accepted.

## Context

T-031 (spec §18.5) builds the registry admin UI: DimensionList, DimensionForm with IconPicker, ValueTree, HierarchyBuilder and MetricLibrary. The done-when is a Playwright add-dimension flow: the new dimension appears in filters and search in under 10 s.

Plan 0.6 (product owner) asks for two things:
- granularities that are easy to set up, parents and children included;
- custom granularities with an icon from an icon library, next to the defaults (country; objective = brand / non-brand / competitor).

## Decision

- **One page, three tabs:** Granularities, Hierarchies and Metric library. The tab and the selected dimension live in the URL.
- **Granularities:**
  - A list groups "This workspace" and "Org-wide defaults". Each entry shows its icon, label and active value count.
  - Selecting one shows:
    - a header (key, scope, "nests under", "required", retire / restore);
    - the value tree;
    - the settings form.
  - New granularity: the key is derived from the name and editable; it never changes after creation. There is also:
    - the icon picker;
    - "Nests under" chips (`allowedParents`);
    - required-on-every-leaf;
    - org-wide (org admins only);
    - an optional values box.
  - Changing an org-wide granularity is for org admins. The server enforces this, and the UI disables with a reason.
- **Icon library:**
  - The picker searches Lucide's full set by name (a radio group; arrow keys move) and starts from about 30 marketing-relevant icons. It can also upload an SVG, which the API sanitizes (≤ 50 KB).
  - Icons render through `lucide-react/dynamic`, so each icon loads on demand and the library adds nothing to the main bundle.
  - Validation: the API's `lucide` package is pinned to the web's `lucide-react` version (1.48.0). Names are now compared with hyphens and case removed, because the old PascalCase→kebab conversion rejected Lucide's real names with digits (`bar-chart-2`). A check confirmed every name the picker offers is accepted.
  - Uploaded icons: `GET /assets/icons/:file` (`workspace.member`) returns the sanitized SVG. The web fetches it with the caller's token and shows it through an `<img>` blob URL, where no script runs.
  - The asset store is still in memory (existing limitation). An icon uploaded by a separate seed process shows the fallback icon in another API process until GCS backs the store; that's a cloud clause.
- **Values, nesting made easy:**
  - The values box takes one value per line. `Parent > Child > Grandchild` nests, creating new levels and matching existing values by label or code. `code = Label` sets the code.
  - Each value has actions: rename (the code stays), add child, **move under** (a select, or drag and drop, with a drop zone for the top level), merge into (the old code becomes an alias), retire / restore. Retired and merged values stay listed on demand.
- **Moving a value moves its subtree:**
  - `PATCH /values/:id { parentCode }` (null means top level) calls the new `reparentDimensionValue` in `@budget/db`. It refuses a move under the value itself or its own subtree, or into another dimension (422).
  - The `dimension_value_path` trigger only recomputes the row that changed, so descendants' `path`s are rewritten in the same statement set.
  - The move is audited with `before.parentValueId`, and emits `registry.changed` (`value.updated`).
  - `addValues` would also re-parent, but its upsert resets aliases and external IDs, so the UI never uses it to move a value.
- **Hierarchies:**
  - Pick a template or start one. Add levels from chips, reorder by drag or arrow buttons, remove levels, make one the default, and see a preview of the tree.
  - A level that cannot nest where it sits says why, and Save is disabled with that reason. The server's check is unchanged.
  - New `PATCH /hierarchy-templates/:id` (`registry.manage`): rename, reorder or make default, with the same path validation as create. It is audited `registry.template.updated` with before and after. A template shapes the tree only, so updating it in place is fine: envelopes never change.
- **Metric library:** the org's metrics as `spend ÷ conversions`-style formulas, plus an "Add a metric" form for org admins (the server rule).
- **The registry list returns admin state:**
  - dimensions: `isActive`, `description`;
  - values: `isActive`, `aliases`, `mergedIntoId`, `externalIds`.
- **Live everywhere:** every registry change invalidates the web's registry, templates and ⌘K-suggest caches, and the API reads the registry on every request. Playwright asserts the new granularity is a filter option and a ⌘K qualifier with its values in under 10 s of Create, without a reload.
- **Elsewhere:** the budget drawer shows each dimension with its icon and label.

## Consequences

- Two new routes (permission-matrix rows included); OpenAPI and the web client regenerated.
- Hierarchy templates can now change in place; saved views keep pointing at the same template id.
- `lucide` 1.47.0 → 1.48.0 in the API (ISC, same major).
