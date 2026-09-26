# ADR-031: Naming templates, match keys and how facts match

## Status

Accepted.

## Context

T-036 (spec §24, plan §4.10) adds:
- naming templates: a `display` name and a `match_key` per envelope;
- a source's parse pattern;
- the matching order of §24.3, where every matched fact records `match_method`.

Done-when: the preview renders five samples; `match_method` is set on 100% of matched golden facts; the coverage KPI is on the run summary.

## Decision

- **Migration** `20260926010000_naming`:
  - it has §24.1's content (the `0004_naming` of the spec), dated like every migration since 0003 so it sorts after the ones already applied;
  - RLS uses the standard `tenant_isolation` policy (the spec's `current_setting` sketch predates `app_visible_workspace_ids()`);
  - a partial unique index keeps **one active template per kind** per workspace;
  - `match_method` is also added to `projection_fact`, because the same matcher sets it on all three fact tables.
- **Rendering** is §24.2's `renderTemplate` in `@budget/domain/naming.ts`:
  - chips are dimension, separator, text and period (`yyyy`, `yyyy-QQ`, `yyyy-MM`, `MMM yyyy`, fiscal);
  - `display` renders labels and `match_key` renders codes.
  - `recomputeNames` in `@budget/db` renders both for a workspace (or given envelopes) in batched `UPDATE … FROM unnest`.
  - It is called on envelope create and move, by the rollup worker on `naming.changed` and `registry.changed`, and inline by the naming commands when the workspace has ≤ 20k envelopes (otherwise the handler does it; the response says `queued`).
- **Display names show where names show:** the planner's flat rows, `envelopePaths` (tree paths, bulk previews, search paths), search titles (reindexed on `naming.changed` for display) and the budget drawer (with the original name under it).
  - The dimension tuple stays the identity.
  - The golden workspace seeds only a match key template, so golden names are unchanged.
- **Matching order (§24.3):**
  1. **External id:** the registry index now says how a cell resolved; a dimension resolved through `dimension_value.external_ids` makes the fact `external_id`.
  2. **Match key:** a column mapped with the new role `match_key`. With the source's `parse_pattern` (a regex whose named groups are dimension keys, validated), its groups become dimension values. Without one, the column is looked up case-insensitively in the live envelopes' `match_key` and resolves to that envelope's tuple. An unknown key is unmatched (queued), not rejected.
  3. **Tuple:** the existing most-specific-subset SQL.

  - Steps 1 and 2 happen in the normalizer, before the upsert, as a provisional `match_method`. The tuple match then finds the envelope and keeps that method, or writes `tuple`; an unmatched fact keeps NULL. `POST /unmatched-spend/map` writes `manual`.
- **Coverage KPI:** `matchCoverage` (matched ÷ total spend) as before, plus `byMethod` (rows and spend per method) in `ingest_run.summary`.
- **API** (spec §24.4):
  - `GET` / `POST /workspaces/:ws/naming-templates`;
  - `PATCH /naming-templates/:id` (version + 1; switching one on retires the other of its kind);
  - `POST /naming-templates/preview` (`{ template, sampleEnvelopeIds[] }`, five live leaves by default);
  - writes are audited and send `naming.changed`.
- **UI:**
  - Admin → Naming templates, with Display name and Match key tabs.
  - `NamingTemplateBuilder` has a palette (granularities with their icons, separators, text, period formats) and chips reordered by drag or arrow buttons (native drag and drop, no dnd-kit, per AGENTS on small dependencies). Options: casing, whitespace and accents. There is a live five-budget preview, and saving renames the budgets.
  - The mapping wizard gains the `match_key` role and an optional parse pattern.

## Consequences

- Sources can match by campaign name without a dimension per column; the Sources screen's coverage has the per-method split.
- Renaming is a batched update per workspace; large workspaces rename in the worker.
