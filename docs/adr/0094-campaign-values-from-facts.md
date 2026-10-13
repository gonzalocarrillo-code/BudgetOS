# ADR-0094: Campaign is a data-derived granularity (its values come from the facts)

## Status

Accepted (EX-9). Amends ADR-0087 (campaign demo data); keeps ADR-082 (demo visibility) as the rule
for which facts count.

## Context

Owner feedback: "there is campaign granularity. that should just be a list of all campaigns coming
from database, not a list like all other granularities."

`campaign` was a registry dimension like `country` or `platform`: its values were hand-managed
`dimension_value` rows. ADR-0087 decision 2 made the demo seed (EX-3) write one such row per demo
campaign (workspace-qualified codes, so the org-wide `(dimension_id, code)` uniqueness held), and
ADR-0087 decision 7 made the demo purge delete them again when no live fact used them. Real
campaigns, though, are whatever the ad platforms and warehouses say, and there are thousands: a
registry list someone keeps by hand is always behind, and ingest refused any campaign the registry
did not know (`unknown campaign "…"`). Campaigns are already fact-only (ADR-0087 decision 1:
never part of an envelope's tuple), and every campaign filter already reads fact
`dimension_values` (ADR-086's fact scope).

## Decision

1. **A dimension says where its values come from**: `dimension.values_source` is `registry` (the
   default; hand-managed rows, unchanged) or `facts` (migration
   `20261024010000_campaign_dimension_values_source`). It is a property of the dimension row, so
   "data-derived" stays a row-level fact of the registry, not a column named after campaign.
   The migration sets every existing `campaign` dimension to `facts`; `DEFAULT_DIMENSIONS` seeds it
   that way (registry seed, workspace templates, the demo seed's `ensureCampaignDimension`).
2. **One query function** — `listFactDimensionValues` (`packages/db/src/fact-dimension-values.ts`)
   — returns a `facts` dimension's values: the distinct non-empty `dimension_values ->> key` of the
   workspace's live (`superseded_at IS NULL`) `spend_fact` and `kpi_fact` rows, each with its live
   spend (Σ `amount_reporting`, Decimal, reporting currency; "0.00" when only KPIs carry it), first
   and last fact date and source systems, largest spend first; server-side search (case-insensitive
   substring) and limit/offset. Demo facts follow ADR-082 / T-5 exactly as the planner does
   (`demo_mode`): they count only while the workspace has no real, live budget, unless
   `includeDemo`. Every consumer reads it: `GET /workspaces/:ws/dimensions/:key/fact-values`
   (`envelope.read`; Registry page, filter bar — and so Budgets, experiment sides and pacing-rule
   scopes, which all use the filter bar — and the match-rule form's campaign suggestions), ⌘K's
   `campaign:` suggestions, and MCP `describe_dimensions` (`factValues`, first 100).
3. **Read-only.** The registry list returns a `facts` dimension with `valuesSource: "facts"` and no
   `values`; the Registry page shows "From your spend data" with a searchable, paged table (name,
   spend, first seen, last seen, source) and no add/edit/merge/retire control. `POST
   /dimensions/:id/values`, `PATCH /values/:id` (rename, move, retire) and `POST /values/:id/merge`
   on a `facts` dimension are refused with `DomainError('VALIDATION')` → 422, before anything is
   written.
4. **Ingest takes the data's value as it is.** `loadRegistry` marks `facts` dimensions;
   `RegistryIndex.resolve` returns the source's (trimmed) value for them instead of "unknown". This
   covers source loads, the mapping preview and manual result entry. The budget CSV import refuses a
   `facts` column (ADR-0087 decision 1: a budget is never set per campaign).
5. **Expand only.** Existing campaign `dimension_value` rows (EX-3's demo seed) are not deleted and
   stay in the table; they are simply no longer listed or editable. The demo seed and the campaign
   reseed (`seedDemoData`, `reseedCampaignDemoData`) no longer write campaign registry rows — the
   facts still carry `campaign`. ADR-0087 decision 2's workspace-qualified codes stay (facts already
   carry them); decision 7's purge step now only tidies rows a pre-EX-9 seed left behind and is a
   no-op for workspaces seeded since.
6. **No new index.** `EXPLAIN ANALYZE` as `budget_app` on a workspace with 50k spend + 50k KPI
   facts: the facts are read through the existing `(workspace_id, period_date) WHERE superseded_at
   IS NULL` indexes where the workspace is a small share of a partition, and by a sequential scan of
   the partition where it is nearly all of it (the right plan: every row is aggregated). The real
   cost was the grouping: with `dimension_values ? key` Postgres estimated ~500 rows for 50k and
   sorted all 100k rows to disk (~450 ms). Filtering on `(dimension_values ->> key) <> ''` (same
   meaning, estimated correctly) and grouping by (value, source) first lets it hash: ~70 ms.

## Consequences

- A new campaign is listed, filterable and suggestible as soon as its first fact loads; nobody keeps
  a campaign list.
- `/query`'s envelope-scoped dimension filters are unchanged: they read `envelope_dimension`, and
  envelopes never carry a campaign (ADR-0087), so a campaign filter there still selects no budget, as
  before. Campaign filtering over facts (experiments' fact scope, ADR-086) needs no registry row and
  is covered by a test.
- Campaign *names* (labels) and naming dictionaries are out of scope (EX-6/EX-7): `campaignNames`,
  `topCampaigns` and `campaignSpend` (the naming preview's own campaign reads) are untouched and can
  move onto `listFactDimensionValues` once that work lands.
- Search documents for the legacy campaign `dimension_value` rows remain indexed until those rows
  are removed in a later contract step.
