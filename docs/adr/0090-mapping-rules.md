# ADR-090: Campaign mapping rules — database reference, naming convention, campaign → budget

## Status

Accepted (EX-5). Extends ADR-0085.

## Context

ADR-0085 made fact → budget assignment one-to-one (manual pin > match rule > tuple, ties
ambiguous). The owner found the Spend data page's "Campaign mapping" (a green / yellow / red
coverage bar and coloured chips) hard to read and asked for plain **rules**: campaign mapping
should come from custom rules that either take the budget **directly from the database** or read
it from the **campaign nomenclature**, besides the existing campaign → budget rule.

What existed: a source mapping could map a column as `match_key` (compared with the envelope's
rendered `match_key`, or parsed with the source's `parse_pattern` regex) at ingest time, and
dimension values carry `external_ids`. Nothing let a source row name its budget, and nothing read
a campaign name already stored on facts (`dimension_values.campaign` is a code; its name is the
registry label).

## Decision

1. **Database reference.** A source mapping column may have role `budget_ref` (at most one per
   source; it is enough identity on its own, like `match_key`). The normalizer carries the cell to
   every fact of the row as `budget_ref` (a new nullable column on `spend_fact`, `kpi_fact`,
   `projection_fact`). It is not part of the natural key, so a row that changes budget is the same
   fact; on reload a changed reference unmatches the fact and the run's pass decides again. At
   match time the reference names a live (not ARCHIVED) envelope **by id** (any case) **or by its
   match key** (case-insensitive, the code the naming template renders, spec §24). No new
   "external id" column on envelope: the match key is already the budget's code.
2. **Naming convention.** A new registry table `naming_convention (workspace_id, id, delimiter,
   tokens jsonb, created_by, created_at, deleted_at, deleted_by)`, RLS enabled and forced,
   SELECT for `budget_mcp`, in the purge list, soft-deleted only. `tokens` is the ordered positions
   of a campaign name: each a dimension key or `null` (ignored), with optional value aliases
   (`FB` → `meta`). Parsing (`parseCampaignName`, `@budget/domain`) splits the campaign's name (the
   `campaign` value's registry label; the code when it has none) on the delimiter; the name must
   have exactly one part per position, no empty part, and every named part must resolve — after
   the position's aliases, case-insensitively — to a registry value code (or a value alias) of that
   dimension. The parsed values are **added** to the fact's tuple (the fact's own values win), then
   ADR-0085's tuple matching applies unchanged (highest key count; ties on one ancestor chain →
   deepest; other ties ambiguous). Several conventions: the oldest that fits a name decides.
   The naming-template registry (`naming_template`, kind `match_key`) was **not** reused: it renders
   envelope → name (one active template per kind, re-rendering every envelope on change), has no
   "ignore" position and no per-position aliases; overloading it would couple two directions.
3. **Precedence** (`matchFacts`, one statement per fact table; the conventions are evaluated once
   per pass in TypeScript over the distinct campaigns in scope and passed as a jsonb map):
   **manual pin > database reference > campaign → budget rule > nomenclature-derived tuple > plain
   tuple.** A database reference that names no live budget leaves the fact unassigned with reason
   `unknown_budget_ref` (`budget_ref_outside_dates` when the budget exists but does not cover the
   date) and never falls through. A campaign name that fits no convention (when the workspace has
   at least one) leaves the fact unassigned with reason `name_mismatch` and does not fall through to
   the plain tuple: a convention exists to make campaigns specific, so a misfit is shown, not sent
   to a coarser budget. A fact without a campaign is not touched by conventions.
4. **Reasons live in `match_status`** (with `ambiguous`), its CHECK widened to `ambiguous`,
   `name_mismatch`, `unknown_budget_ref`, `budget_ref_outside_dates`; `match_method` gains
   `reference` and `naming` (`naming` when the winning budget needs a value read from the name).
   Additive: the previous code only tests `match_status = 'ambiguous'`, so during a deploy it
   counts the new reasons as plain unmatched, which they are.
5. **Writes.** `POST /workspaces/:ws/naming-conventions`, `DELETE /naming-conventions/:id` and
   `POST /workspaces/:ws/naming-conventions/preview` need `source.manage` (a convention moves spend
   across every budget, a data operation like the unmatched queue). A write re-matches every live,
   unpinned fact with a campaign outside closed periods in the same transaction and emits one
   `audit_event` (`naming_convention.created` / `.deleted`) and one `facts.loaded` outbox row naming
   the envelopes that gained or lost facts. The database reference is part of the source mapping
   (`PATCH /sources/:id`, its own audit and outbox); it applies from the source's next run.
   `GET /workspaces/:ws/match-rules` lists the three kinds: `rules`, `conventions`, `references`
   (sources whose mapping has a `budget_ref` column). Coverage's open campaigns carry `reason`.
6. **UI.** The coverage bar and coloured chips are gone (the coverage endpoint stays). The Spend
   data page shows "Rules": one paragraph saying the precedence in plain words, the rules of the
   three kinds (kind, what it matches, target, delete) and "Add rule" (campaign → budget; from the
   database: source + column; nomenclature: delimiter, a real campaign name split into parts, a
   dimension and aliases per part, live preview on the largest real campaigns). Unassigned and
   ambiguous campaigns are a plain list under "Unmatched spend", each with "Create rule".

## Consequences

- A workspace with no convention and no `budget_ref` column matches exactly as under ADR-0085.
- Adding a convention can turn previously tuple-matched campaign facts into `name_mismatch` when
  their names do not fit; the preview shows this before saving, and deleting the convention
  restores the previous assignment.
- A database reference to an archived or deleted budget leaves the fact unassigned (visible), not
  on another budget.
- The convention pass reads the distinct campaigns in scope each matching pass; with very many
  campaigns this is one extra query and an in-memory parse per pass. Acceptable for now; a cached
  per-campaign parse can be added if it shows up in profiles.
- `parse_pattern` (per-source regex on a `match_key` column, T-036) still works at ingest; the
  naming convention is the source-agnostic, match-time equivalent.
