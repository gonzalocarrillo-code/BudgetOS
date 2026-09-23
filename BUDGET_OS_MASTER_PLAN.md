# Budget OS — Master Plan

**Internal media budget system of record for a global agency**
Version 0.5.1 · 23 Sep 2026 · Owner: [PRODUCT OWNER] · Status: Draft for alignment

Changes in 0.5.1: Appendix D (agent build kit: how the plan, the build spec and AGENTS.md fit together, and the rules that keep every task unambiguous); package names aligned with the spec (`@budget/*`).

Changes in 0.5: adopt mature MIT-licensed libraries where they exist and build only the delta — Glide Data Grid for the grid engine, SVAR React Gantt (MIT core) for the timeline, Meilisearch as the search swap target (§11.5, §11.9); roadmap re-sized again (§13).

Changes in 0.4: no commercial components or licences — the data grid and the timeline are built in-house on open-source foundations (§11.5, §11.9, Epics 0.7–0.8); roadmap re-sized (§13).

Changes in 0.3: target and budget timelines (§4.11), naming templates and match keys (§4.10), experiments (§4.12), manual result entry (§6.1), admin/settings IA (§11.6), home and onboarding (§11.7), Camphouse product-screen analysis (§2.2).

Changes in 0.2: added editability model (§9.3), exact filters (§11.2), indexed global search (§11.3), KPI/CPA targets (§4.8), comments, conversations and tagging (§8.6), dynamic dimension registry with custom icons (§4.2), scalability design (§5.3). Visual design is owned by the design team and removed from scope here.

> This document is the single center of the program. Every workstream, ticket, ADR and design links back to a section here. When something changes, this file changes first.
>
> Working name: **Budget OS** (rename freely). Reference product: [Camphouse](https://camphouse.io) — we replicate its governance model and beat it on UX, data fidelity and openness.
>
> **Implementation:** this plan is built by an AI coding agent. The agent reads `AGENTS.md` first, then this plan, then `BUDGET_OS_BUILD_SPEC.md`, which holds the exact schema, code, contracts and the ordered task list (T-001 … T-035). Every epic's `/goal` below maps to tasks in the build spec §22.

---

## 0. How to read this document

- **§1–3** — why, what we learned from Camphouse, and what "better" means.
- **§4–6** — the data model, the GCP architecture, and integrations (the parts that must be right from day one).
- **§7–10** — governance, permissions, alerts, collaboration, editability, reporting: the Phase 1 must-haves in depth.
- **§11** — functional UX requirements (filters, search, grid behaviour) and the React stack. Visual design lives with the design team.
- **§12** — data quality and AI-readiness (the "set us up for success" section).
- **§13** — the phased roadmap. Every epic carries a `/goal` line: a single, testable statement of done.
- **§14–16** — team, risks, decisions, open questions.
- **Appendix D** — how coding agents build this: the companion `BUDGET_OS_BUILD_SPEC.md` and `AGENTS.md`, and the rules that make every task unambiguous.

Terminology used throughout:

| Term | Meaning |
|---|---|
| **Budget** | An approved amount of money for a defined scope (dimension combination) over a period. |
| **Envelope** | A budget node in the hierarchy (e.g. Client → Market → Platform). Parent envelopes cap the sum of children. |
| **Allocation** | Distribution of a parent envelope into children. |
| **Version** | An immutable snapshot of a budget tree. Approvals attach to versions, never to live rows. |
| **Actuals** | Real spend, ingested from the data warehouse (Snowflake/BigQuery) or Sheets. |
| **Projection** | Forecast spend to end-of-period, computed by the data team's formulas (ingested, not re-computed by us in Phase 1). |
| **Closure** | A locked, reconciled snapshot of a period (month or quarter). Cannot be edited after lock. |
| **Dimension** | A grouping axis: client, brand, market/country, region, platform, account, campaign, objective, audience, funnel stage, channel, product line, fiscal period… Configurable, not hard-coded. Admins add their own, with their own icon. |
| **Target** | A goal attached to a scope and period. Two families: **budget targets** (amount) and **KPI targets** (CPA, CPL, ROAS, CPM, conversions…). Targets are versioned like budgets. |
| **Tag** | A free label on any entity (envelope, target, request, alert, comment) used for filtering and search. Distinct from **@mention**, which tags a person or group in a comment. |
| **Thread** | A conversation anchored to an entity; comments, mentions, attachments, resolvable. Appears inside the entity's Decision Timeline. |

---

## 1. Context and goals

We run paid media for many clients across dozens of markets and thousands of campaigns. Today budgets, approvals and spend live in disconnected sheets, threads and platform UIs. We want:

1. **One authoritative source** of approved budgets at every granularity we operate on.
2. **Auditable governance**: who set it, who approved it, when, why — reconstructable months later.
3. **Proactive pacing**: alerts before over/under-spend hurts a target, driven by actuals and projections the data team already computes.
4. **Openness by default**: CSV export everywhere, warehouse connectivity, and a **read-only MCP server** so internal AI assistants and analysts can query budgets safely.
5. **Data structures clean enough** that, later, we can ask "how close were we to budget, and why?" and let AI help — without a cleanup project first.
6. **Everything editable, nothing lost**: budgets and targets move constantly; every edit is a version, every version is reconstructable, and edits are as fast as a spreadsheet cell.
7. **Find anything in two keystrokes**: an indexed global search across every entity, with structured qualifiers, in the style of the GCP console search bar.
8. **Budget and performance together**: CPA (and other KPI) targets sit next to budget targets on the same scope, so pacing means "spending at the right rate at the right efficiency".
9. **Conversation where the decision is**: comments, threads, @mentions and tags on every envelope, version, request and alert, all inside the audit trail.

Non-goals for Phase 1: media planning (flowcharts, line items, UTMs), activation / pushing budgets into ad platforms, invoicing/finance reconciliation, forecasting models of our own.

---

## 2. Reference product: what Camphouse does

Research summary of camphouse.io (Sept 2026). Camphouse positions itself as a "media operations platform" with four modules: Budget Allocation, Media Planning, Media Activation and Reporting, built on a "One Media Data Model" and "Collaborative Workflows".

### 2.1 Functionality inventory

**Budget Allocation module**
- Top-down allocation: set a high-level financial target, distribute across regions, brands, campaigns.
- Hard over-allocation caps at organization or client level; teams cannot commit more than authorized.
- Pacing visibility: planned vs committed vs remaining per target.
- Real-time validation: alerts and blocks when a plan exceeds its allocated bucket.
- Targets ("North Star" KPIs) attached to budgets; spend paced against targets.
- KPI-driven allocation using historical benchmarks.
- Multi-currency support.
- Dynamic re-allocation based on remaining runway.

**One Media Data Model**
- Enforced unified taxonomy across three phases: Allocation → Plan → Actuals.
- Native naming-convention and UTM generation from plan dimensions.
- 1:1 placement match between planned lines and platform actuals.
- Historical data searchable across all dimensions, not just totals.
- Export of clean structured data to Snowflake, BigQuery, AWS.
- Marketed as the foundation for an "AI Planner" (announced for H1 2026).

**Collaborative Workflows**
- Shared workspaces for advertiser + multiple agencies with SOW-scoped visibility.
- Dual taxonomy mapping (advertiser's business units vs agency's billing/trafficking).
- Conditional Approval Engine: automated approval chains triggered by budget threshold, media type, or market.
- Version control & snapshots: compare Plan v1 vs vFinal; see who approved what and when.
- Native discussions and notifications on line items with an immutable audit trail.
- Role-based views: **Sheet** view for planners, **Flowchart** for leadership, **Reports** for finance.
- Plan-to-live hand-off locks naming and UTMs after approval.

**Reporting**
- Plan vs actual dashboards, pacing, reconciliation exports.

**AI Co-Pilot**
- Conversational assistant over the plan data; generative brief templates (coming soon).

### 2.2 Visual and UX observations

From the marketing site and the product GIFs (Hub, Results, Settings → Plugins, Settings → Naming conventions, Flowchart):

- **Shell**: flat left nav (Hub, Targets, Overview, Media Overview, Results, Reports, Files, Subsidiaries, Settings); top bar with account switcher, centred global search, AI button, notifications, help, avatar. A persistent date-range chip sits top-right on data screens.
- **Hub**: welcome, a Target vs Planning gross-budget strip, "Last created plans" (recency, with date range and market tag), an AI panel with suggested questions, and a 5-step guided product tour.
- **Results**: spreadsheet-style manual result entry with a pinned Total row, Export, a "Send for approval" button, and colour-coded media-type tabs (Paid Social, TV, OOH, DOOH) along the bottom. This is how offline/non-integrated media gets actuals in.
- **Settings**: two-level IA — Organization (General, Users and roles, Plugins) and Media planning (Media types and fields, Exchange rates, Media inventory, Media vehicles, Tags, Plan settings, Approval flow, Activation, Plan fields, File fields, Naming conventions, Forecast configuration, Media orders, AI). Integrations are a card gallery with logo, description, prerequisites and "Manage or Add".
- **Naming conventions**: a chip-based template builder (plan fields + tag categories + separators), casing, URL-ize and whitespace options, with a live preview. Positioned as the link between planned and results data.
- **Flowchart**: campaigns and plans as bars on a calendar/Gantt, grouped by hierarchy, used as the leadership and target-timeline view.
- The core object throughout is a **grid** with grouped rows, frozen left columns, inline editing and colour-coded status chips.
- Weaknesses to exploit: settings are long and unsearchable; disabled actions ("Send for approval") give no reason; home is recency-driven rather than "what needs me"; approval status is per plan, not per envelope; pacing is numeric rather than glanceable; filter state resets on navigation; modal-heavy editing.

### 2.3 What we take, what we skip, what we beat

| Camphouse concept | Our decision |
|---|---|
| Top-down envelopes with hard caps | **Take.** Core of §4. |
| Approval chains by threshold/market | **Take and extend** with policy-as-configuration (§8). |
| Version snapshots + approval attached to a version | **Take.** Non-negotiable for traceability. |
| Unified taxonomy | **Take**, as configurable dimension registry (§4.2). |
| Sheet / Flowchart / Report views | **Take all three.** Sheet + Report + a Timeline (Gantt) view for envelopes and targets in Phase 1; drag-edit and scenario overlays in Phase 2. |
| Manual result entry with approval | **Take.** Offline media (TV, OOH, print) needs a governed way in (§6.1). |
| Naming-convention template builder | **Take the builder, change the purpose:** generate envelope display names and the actuals match key from dimensions (§4.10). UTM generation stays out. |
| Guided product tour, suggested AI questions | **Take.** Directly serves the Ease-of-Use must-have (§11.7). |
| Two-level settings IA | **Take the coverage, fix the navigation:** searchable settings grouped by who owns them (§11.6). |
| Media planning line items, UTMs, activation | **Skip.** Not budget management. |
| Their own pacing/forecast formulas | **Skip.** We ingest the data team's Snowflake/Sheets formulas. |
| Closed data model, export via their pipeline | **Beat:** BigQuery-native history, CSV on every table, read-only MCP. |
| Pacing as numbers | **Beat:** pacing bars, burn curves, projected-close markers inline in the grid. |
| Approval status per plan | **Beat:** approval state visible on every envelope at every level. |
| Modal-heavy editing | **Beat:** inline editing, right-hand drawer, keyboard-first grid, URL-persisted filters. |

---

## 3. Product principles

1. **Governance without friction.** Compliance fails when the tool is slower than the sheet. Every must-have control must cost the user fewer clicks than the workaround.
2. **Nothing is approved that isn't a version.** Live edits are drafts. Approvals lock a snapshot. Full stop.
3. **Every number has a lineage.** Budget: who/when/why/version. Actuals: source system, ingestion run, formula version.
4. **Granularity is data, not schema.** New dimensions (e.g. "creative format") are added by an admin, not by a migration.
5. **Aggregate anywhere.** Any combination of dimensions can be a roll-up; the tree is one view, the pivot is another.
6. **Open by default.** Every screen exports CSV. Every table lands in BigQuery. Read access is API- and MCP-addressable.
7. **Boring, correct infrastructure.** Postgres for truth, BigQuery for history, Cloud Run for compute. No exotic services.
8. **Sheets is a client, not a source of truth.** We read from Sheets (actuals/projections) and export to Sheets; we never let Sheets write budgets without going through approval.
9. **Adopt open source, build the delta.** No commercial components, paid tiers or per-seat licences; every dependency is MIT/Apache/BSD and vendorable. Where a mature open-source library covers most of a hard problem (grid rendering, Gantt interaction, search indexing), we adopt it and build only what is specific to budgets. We never let a "PRO edition" feature gate our roadmap: if a needed feature is paid-only, we implement it ourselves on the open core.

---

## 4. Domain and data model

### 4.1 Core entities

```
Organization
 └─ Workspace (client or business unit)            ← tenancy & permission boundary
     ├─ DimensionRegistry (per workspace, inherits org defaults)
     ├─ FiscalCalendar (periods: months, quarters, custom)
     ├─ BudgetTree
     │   ├─ Envelope (node)                          ← the budget object
     │   │   ├─ dimension_values (jsonb, validated against registry)
     │   │   ├─ period_id
     │   │   ├─ currency
     │   │   ├─ parent_envelope_id (nullable)
     │   │   └─ status (draft | pending | approved | locked | archived)
     │   ├─ EnvelopeVersion (immutable snapshot of amount + metadata)
     │   ├─ Allocation (parent_version → child_version, amount)
     │   └─ ApprovalRequest → ApprovalDecision(s)
     ├─ Target → TargetVersion (budget targets and KPI targets: CPA, ROAS…)  ← same versioning as budgets
     ├─ MetricDefinition (admin-extensible metric library)
     ├─ SpendFact (actuals, from warehouse)
     ├─ KpiFact (conversions, revenue, impressions… long format)
     ├─ ProjectionFact (projected spend, from warehouse/Sheets)
     ├─ PacingRule → Alert → AlertDelivery
     ├─ Thread → Comment (anchored to any entity, @mentions, resolvable)
     ├─ Tag → Taggable (labels on any entity)
     ├─ SavedView (filters + granularity, personal / shared / default)
     ├─ NamingTemplate (display name + match key from dimension chips)
     ├─ Experiment → ExperimentEnvelope (test budgets with hypothesis, control, criterion, decision)
     ├─ ManualEntryBatch (offline actuals, draft → approved → facts)
     ├─ SearchDocument (index, maintained from the outbox)
     ├─ PeriodClosure (locked reconciliation snapshot)
     └─ AuditEvent (append-only)
```

### 4.2 Dimension registry (the granularity engine)

Granularities are **data, not schema**. Adding "creative format" or "retailer" is an admin action in the UI, takes effect immediately, and needs no migration or deploy. Everything downstream (grid grouping, filters, roll-ups, permissions, search qualifiers, MCP query params) reads the registry at request time.

#### What an admin can do, without engineering

| Action | Detail |
|---|---|
| **Create a dimension** | key, label, description, **icon** (pick from the bundled Lucide set or upload an SVG), colour, data type (`enum` · `text` · `reference` to another dimension · `date_bucket`), cardinality hint |
| **Add values** | one at a time, paste a list, import CSV, or sync from a source (Sheets tab, Snowflake dimension table, platform API list of accounts) |
| **Nest values** | values can be hierarchical inside one dimension: Region ▸ Country ▸ City; Objective ▸ Sub-objective. Stored as an `ltree` path |
| **Set parent/child between dimensions** | drag-and-drop **hierarchy builder**: `region → country`, `platform → account → campaign`. A dimension may have several valid parents used in different templates |
| **Build hierarchy templates** | ordered paths the tree view follows (`[client, region, country, platform, objective]`). Several per workspace, switchable at any time; envelopes don't change, only the tree does |
| **Set constraints** | required-for-leaf, allowed values per parent value (e.g. `objective=competitor` only under `channel=paid_search`), default value, sort order |
| **Retire / merge / rename** | retired values stay filterable and keep history; merges keep the old code as an alias so ingestion never breaks; renames are label changes on a stable code |
| **Map external IDs** | per value: `{"meta_account_id": "…", "dv360_advertiser_id": "…", "snowflake_key": "…"}` so actuals match automatically |
| **Scope to workspaces** | org-level dimensions inherited by all workspaces; workspace-level dimensions private to one client |

#### Defaults shipped (org level; workspaces inherit and can extend or override)

| Dimension | Default values | Default icon |
|---|---|---|
| `client` | — (from workspace) | briefcase |
| `brand` | — | tag |
| `business_unit` | — | building |
| `region` | AMER, LATAM, EMEA, APAC | globe |
| `country` | ISO 3166-1 alpha-2, nested under region | flag |
| `channel` | paid_social, paid_search, programmatic, retail_media, video, affiliate, other | layers |
| `platform` | meta, google_ads, dv360, tiktok, amazon, pinterest, snapchat, linkedin, x, microsoft_ads, other | plug |
| `account` | — (synced from platforms) | user-circle |
| `campaign` | — (synced from platforms) | megaphone |
| `objective` | brand, non_brand, competitor, awareness, consideration, conversion, retention | target |
| `funnel_stage` | upper, mid, lower | filter |
| `audience` | prospecting, retargeting, lookalike, crm, broad | users |
| `product_line` | — | package |
| `creative_format` | static, video, carousel, collection, story, search_text, shopping | image |
| `fiscal_period` | months, quarters, fiscal years from the workspace calendar | calendar |

Any of these can be hidden, renamed or re-nested per workspace. A workspace typically adds 3–10 custom dimensions (e.g. `retailer`, `promo_wave`, `market_tier`, `agency_team`).

#### Schema

```sql
dimension (
  id, org_id, workspace_id (null = org-wide), key, label, description,
  data_type,                      -- enum | text | reference | date_bucket
  icon text, color text,          -- 'lucide:globe' or 'asset:<gcs-id>'
  allowed_parents text[],         -- dimension keys this one can nest under
  is_required_for_leaf boolean, sort_order int, is_active boolean,
  created_by, created_at, version int
)
dimension_value (
  id, dimension_id, code, label, path ltree,      -- path enables Region ▸ Country ▸ City in one dimension
  parent_value_id, aliases text[], external_ids jsonb,
  is_active boolean, retired_at, merged_into_id
)
hierarchy_template (
  id, workspace_id, name, path text[],            -- ['client','region','country','platform','objective']
  is_default boolean, created_by, version int
)
value_constraint (
  id, dimension_id, when_dimension_key, when_value_code, allowed_value_codes text[]
)
-- envelope keeps dimension_values jsonb for fast reads AND
envelope_dimension (envelope_id, dimension_id, value_id)   -- normalised for exact filters at scale
-- indexes: GIN on envelope.dimension_values; (workspace_id, dimension_id, value_id, envelope_id) on envelope_dimension;
--          GiST on dimension_value.path
```

Every registry change is versioned and audited (`dimension.version`, `audit_event`). A closure snapshot records the registry version it was taken under, so a Q3 report still reads with Q3's taxonomy even if Q4 renames values.

#### Roll-ups on dynamic hierarchies

Roll-ups are computed for the **active hierarchy templates** and cached (see §5.3). The pivot view and the MCP `query_budgets` tool ignore templates and group by any subset of dimensions, including custom ones, because they resolve through `envelope_dimension`. Adding a dimension therefore adds a grouping option everywhere within seconds.

### 4.3 Envelopes and versions

- `envelope` is the stable identity (dimension tuple + period + currency).
- `envelope_version` is where the amount lives. Every edit creates a new version row; `envelope.current_version_id` points at the latest **approved** version, `envelope.draft_version_id` at the working draft if any.
- Constraint enforced in DB and API: `SUM(children.amount) <= parent.amount` for approved versions, unless the parent has `allow_over_allocation = true` with an approval override.
- `amount_type` per version: `budget | committed | forecast` (Phase 2 adds `scenario`).
- Amounts stored as `NUMERIC(18,2)` in envelope currency **and** `NUMERIC(18,2)` in workspace reporting currency, with `fx_rate_id` pointing at the rate table used. Never recompute FX on read.
- **Dates are free.** An envelope has `start_date`/`end_date` (any range, not only fiscal periods) plus an optional `period_id` for calendar alignment. Monthly **phasing** lives in `envelope_phasing(envelope_version_id, month, amount)` so a Q4 budget can be front-loaded for Black Friday and re-phased later without touching the total.
- **Re-parenting, split and merge** are first-class operations (`envelope_lineage(from_envelope_id, to_envelope_id, kind (move|split|merge), version_id, actor, at)`), so history follows the money.
- Optimistic concurrency: every write carries the `version_id` it was based on; conflicting inline edits are rejected with the current value shown, never silently overwritten.

### 4.4 Actuals, KPIs and projections

```sql
spend_fact (
  id, workspace_id, envelope_id (nullable until matched),
  dimension_values jsonb, period_date date, currency, amount,
  source_system,          -- 'snowflake' | 'sheets' | 'bigquery' | 'csv'
  source_run_id,          -- ingestion run
  source_row_hash,        -- dedup
  loaded_at
) PARTITION BY RANGE (period_date)
kpi_fact (                -- long format: one row per metric, scales to new metrics without schema change
  id, workspace_id, envelope_id, dimension_values jsonb, period_date date,
  metric text,            -- 'conversions' | 'revenue' | 'impressions' | 'clicks' | 'leads' | custom
  value numeric, attribution_model text, source_system, source_run_id, loaded_at
) PARTITION BY RANGE (period_date)
projection_fact ( ... same shape as spend_fact ..., metric text default 'spend', formula_version text, horizon_end date )
```

Derived KPIs (CPA = spend / conversions, ROAS = revenue / spend, CPM, CPC, CTR) are **computed at query time** from `spend_fact` and `kpi_fact` at whatever grouping the user asks for, so a CPA roll-up for "LATAM › Meta" is always weighted correctly and never stored as an average of averages.

**Matching rule:** facts are matched to envelopes by dimension tuple, most-specific first. Unmatched facts land in an `unmatched_spend` queue with a UI to map them (and to add a dimension_value.external_id so it never happens again). Match coverage is a tracked KPI (target ≥ 99% of spend matched within 24h).

### 4.5 Closures

`period_closure(workspace_id, period_id, closed_by, closed_at, budget_snapshot_ref, actuals_snapshot_ref, variance_summary jsonb, status)`

Closing a quarter:
1. Freezes all envelopes in the period (`locked`).
2. Writes a BigQuery table partition `closures.budget_vs_actual_<period>` with every leaf and every roll-up.
3. Blocks new spend_fact loads for that period unless an admin runs an explicit "restate" with reason (recorded as AuditEvent).

This is what future "how close were we" analysis reads from.

### 4.6 Audit

`audit_event(id, workspace_id, actor_id, actor_type (user|system|mcp), action, entity_type, entity_id, before jsonb, after jsonb, reason text, request_id, occurred_at)` — append-only, replicated to BigQuery. Every write path emits one. The Decision Timeline UI (§8.4) is a read of this table.

### 4.7 Storage split

| Store | Holds | Why |
|---|---|---|
| **Cloud SQL (PostgreSQL 16)** | All entities above, current state, row-level constraints | ACID, FK integrity, row-level security for tenancy |
| **BigQuery** | CDC replica of Postgres (via Datastream), spend/projection facts at scale, closure partitions, audit history | Analytics, Looker/Sheets connectors, AI training later |
| **Cloud Storage** | CSV imports/exports, closure PDFs | Cheap, signed URLs |
| **Memorystore (Redis)** | Sessions, rate limits, materialized pacing cache | Speed |

### 4.8 Targets: budget targets and KPI targets (CPA, ROAS, …)

A target is a goal attached to a **scope** (a single envelope, or any dimension filter such as "all `objective=non_brand` in Brazil") for a **period**. Budget targets and KPI targets share one model so they sit side by side in the grid, in alerts and in reports.

```sql
metric_definition (               -- admin-extensible metric library
  id, org_id, key,                -- 'budget' | 'cpa' | 'cpl' | 'roas' | 'cpm' | 'cpc' | 'ctr' | 'conversions' | custom
  label, numerator text, denominator text,   -- e.g. numerator='spend', denominator='kpi:conversions'
  direction text,                 -- lower_is_better | higher_is_better
  format text, unit text, is_active
)
target (
  id, workspace_id, scope_type,   -- envelope | filter
  envelope_id, scope_filter jsonb, period_id, start_date, end_date,
  metric_key, owner_id, status, current_version_id, draft_version_id
)
target_version (
  id, target_id, value numeric, comparator,   -- lte | gte | eq | between
  value_upper numeric, currency, rationale, created_by, created_at,
  source,                         -- manual | sheet | snowflake | derived
  approval_request_id (nullable)
)
```

Rules:

- **Targets change; versions keep up.** Editing a target creates a `target_version` exactly like a budget edit. Whether a target change needs approval is a policy condition (`entity_type = target`, `metric_key`, `delta_pct`), so a CPA tweak can be free while a budget change is gated.
- **Inheritance.** A target on a parent applies to children unless a child overrides it; overrides are visible as a chip on the child and in the parent's drawer.
- **Budget ↔ KPI linkage.** When an envelope has both a budget and a CPA target, the system shows the implied volume (`€1.20M ÷ €18 = 66,667 conversions`) and the current efficiency (`actual CPA vs target`, `projected conversions vs implied`). Nothing is auto-adjusted; it is decision support.
- **Pacing against KPI targets** uses the same rule engine (§8.4): `cpa_vs_target_pct`, `kpi_vs_target_pct`, `efficiency_adjusted_pace`.
- **Sources.** Targets can be typed in, pasted, imported from a Sheet range, or synced from a Snowflake table the data team owns (e.g. quarterly CPA targets by market). Source rows are validated like actuals and rejected rows reported.
- **Default metrics shipped:** budget, CPA, CPL, CPM, CPC, CTR, ROAS, conversions, revenue, impressions, reach. Admins add metrics by defining numerator/denominator over `spend_fact`/`kpi_fact` metrics — no deploy.

### 4.9 Comments, threads and tags

```sql
thread (id, workspace_id, anchor_type, anchor_id, title, status (open|resolved), created_by, created_at, resolved_by, resolved_at)
-- anchor_type: envelope | envelope_version | target | approval_request | alert | closure | dimension_value | cell (envelope_id + month)
comment (id, thread_id, parent_comment_id, author_id, body_md, mentions jsonb, attachments jsonb, created_at, edited_at, edit_history jsonb, deleted_at)
tag (id, workspace_id, name, color, kind (label|status|team|custom), created_by)
taggable (tag_id, entity_type, entity_id, tagged_by, tagged_at)
```

Comments are soft-deleted and edit-versioned; they are part of the audit surface (§4.6) and appear interleaved in the Decision Timeline. Details of behaviour in §8.6.

### 4.10 Naming templates and match keys

A chip-based template builder (as in Camphouse's naming conventions) defines two strings per workspace from dimension values and separators:

- **Display name template** — how envelopes are titled in grids, search and Slack: e.g. `{country} · {platform} · {objective} · {fiscal_period}` → "BR · Meta · Non-brand · Q4 2026". Regenerated when dimension labels change; the stable identity stays the dimension tuple.
- **Match key template** — the normalised string used to join incoming actuals and KPIs to envelopes when a source lacks explicit IDs: e.g. `{country}_{platform}_{objective}` with casing and whitespace rules. Sources can supply their own campaign-name pattern and the ingester parses dimension values out of it (`parse_pattern` per source). Every match records which rule matched (`match_method: external_id | match_key | manual`).

```sql
naming_template (id, workspace_id, kind (display|match_key), chips jsonb, separator, casing, whitespace_rule, version, is_active)
```

UTM and platform naming generation are explicitly out of scope; the builder exists for our own consistency and matching.

### 4.11 Target and budget timelines

Every envelope and every target has `start_date`/`end_date`, so both are natively bars on a calendar. The **Timeline view** (§11.4) renders them as a Gantt grouped by any hierarchy template or ad hoc dimension path, with:

- fiscal calendar header (weeks · months · quarters · FY) from the workspace calendar, plus market holidays and client key dates as vertical markers;
- envelope bars filled by spend-to-date, with the projected-close position marked, coloured by pacing state;
- **target lanes** under each envelope: budget target, then each KPI target; overlapping targets (annual CPA target with a Q4 override) render as stacked lanes, and the effective target at any date is the most specific one;
- markers for version approvals, alerts fired, closures and comments;
- a today line and an as-of scrubber (drag to see the timeline as it was on a past date);
- Phase 2: drag to move or resize envelopes/targets (creates a draft version), scenario overlays, and dependency lines between envelopes (e.g. "Awareness must run before Conversions").

The timeline reads the same query AST as the grid; a filter set opened in Explorer can be switched to Timeline without losing state.

### 4.12 Experiments (test budgets)

Agencies run tests constantly: a new platform, an objective split, a creative format. Tests are budgets with a question attached.

```sql
experiment (
  id, workspace_id, name, hypothesis, kind (platform_test | objective_test | audience_test | creative_test | geo_holdout | custom),
  test_scope_filter jsonb, control_scope_filter jsonb (nullable),
  primary_metric_key, success_criterion jsonb,       -- e.g. {"metric":"cpa","comparator":"lte","value":18,"vs":"control"}
  start_date, end_date, status (planned | running | evaluating | concluded | abandoned),
  owner_id, decision text, decided_by, decided_at, tags
)
experiment_envelope (experiment_id, envelope_id, role (test|control))
```

- A test envelope is an ordinary envelope tagged `experiment` and linked to an `experiment`; it obeys caps, approvals and pacing like any other, so test spend is never invisible to finance.
- Experiments appear as a lane on the Timeline with their evaluation window, and as a filter/search qualifier (`experiment:running`).
- The Experiments list shows test vs control KPI side by side from `kpi_fact`, the success criterion, and the recorded decision; concluding an experiment requires a decision comment, which becomes part of the Decision Timeline of the envelopes involved.
- Phase 1 ships the entity, the timeline lane and the side-by-side readout. Statistical significance and automated read-outs are Phase 3.

---

## 5. Architecture (GCP)

```
                    ┌──────────────────────────────────────────────────────┐
                    │  Identity: Google Workspace SSO via Identity Platform │
                    │  + Identity-Aware Proxy in front of all Cloud Run     │
                    └──────────────────────────────────────────────────────┘
                                          │
   React SPA (Cloud Run static / Firebase Hosting) ──► API Gateway ──► Cloud Run: budget-api (Node/TS, NestJS)
                                                                       │
                          ┌────────────────────────────────────────────┼─────────────────────────────┐
                          │                                            │                             │
                 Cloud SQL Postgres (private IP)              Pub/Sub topics                  Cloud Run: mcp-readonly
                          │                                   (budget.changed,                (MCP server, HTTP+SSE,
                 Datastream CDC ──► BigQuery                   alert.triggered)               read-only service acct)
                                                                       │
                                              ┌────────────────────────┼──────────────────────┐
                                     Cloud Run Job:              Cloud Run: alert-worker      Cloud Run: ingest-worker
                                     pacing-evaluator            (Slack, email via            (Snowflake connector,
                                     (Cloud Scheduler, 15 min)    SendGrid/Gmail API)          Sheets API, BQ, CSV)
                                                                                                        │
                                                                                     Snowflake ◄──► Secret Manager (creds)
                                                                                     Google Sheets
                                                                                     BigQuery (data team datasets)

   OpenAI API (all LLM/embedding work: Phase 2 copilot, variance narratives, Sheet-column mapping suggestions)
```

### 5.1 Services

| Service | Runtime | Responsibility |
|---|---|---|
| `web` | React 19 + Vite, served from Cloud Run (nginx) | UI |
| `budget-api` | Node 22 / TypeScript / NestJS, Prisma | REST + OpenAPI, RBAC, versioning, approval engine, exports |
| `ingest-worker` | Node / TypeScript | Scheduled and on-demand pulls from Snowflake, Sheets, BigQuery; CSV import jobs |
| `pacing-evaluator` | Cloud Run Job, Cloud Scheduler every 15 min (configurable) | Evaluates PacingRules against latest facts, emits alerts |
| `alert-worker` | Node | Delivers alerts (in-app, Slack, email), handles digests and snooze |
| `mcp-readonly` | Node, `@modelcontextprotocol/sdk` | Read-only MCP server (§6.4) |
| `export-worker` | Node | Async CSV/XLSX/BigQuery exports, signed URLs |
| `rollup-worker` | Node, Pub/Sub-triggered | Incrementally recomputes cached roll-ups per hierarchy template when envelopes, facts or the registry change (§5.3) |
| `search-indexer` | Node, Pub/Sub-triggered | Maintains the `search_document` index from the outbox; re-indexes on registry or tag changes (§11.3) |
| `notify-worker` | Node | Fans out @mentions, thread replies, tag subscriptions and alert deliveries (§8.5, §8.6) |

All services: one monorepo (Turborepo), shared `packages/domain` (types, zod schemas, permission matrix), shared `packages/db` (Prisma schema + migrations).

### 5.2 Cross-cutting

- **Auth:** Google Workspace SSO. Identity Platform issues tokens; IAP enforces at the edge. Service accounts per service, least privilege. No API keys in code; Secret Manager only.
- **Tenancy:** `workspace_id` on every table, Postgres Row-Level Security policies set from JWT claims per request.
- **Observability:** Cloud Logging (structured JSON with `request_id`, `actor_id`, `workspace_id`), Cloud Trace, Error Reporting, uptime checks. SLO: API p95 < 400 ms for grid queries at 50k envelopes.
- **CI/CD:** GitHub Actions → Cloud Build → Cloud Run revisions with traffic splitting; Prisma migrations run as a Cloud Run Job gated on approval. Preview environments per PR.
- **Environments:** `dev`, `staging`, `prod` as separate GCP projects. Prod data never copied down; synthetic seed for dev.
- **Infrastructure as code:** Terraform, one module per service.
- **Backups:** Cloud SQL PITR 7 days + daily export to GCS (35-day retention). BigQuery time travel 7 days.

### 5.3 Scalability design

Built for: 50+ workspaces, 100k+ envelopes per workspace, 20+ dimensions (many custom), thousands of campaigns per market, 100M+ facts per year, millions of comments and audit events, and hundreds of concurrent editors. Principles:

| Concern | Approach |
|---|---|
| **Schema never changes for business growth** | New dimensions, values, metrics, policies, rules, tags and templates are rows. Migrations are for platform features only. |
| **Exact filters at scale** | `envelope_dimension` junction table with composite indexes for equality/IN filters; GIN on `dimension_values` for ad hoc jsonb queries; `ltree` GiST for hierarchical value filters ("everything under EMEA"). The query planner picks the path per predicate. |
| **Roll-ups not computed on read** | `rollup_cache(template_id, node_path, period, measures jsonb, data_version)` maintained incrementally by `rollup-worker` from change events. The grid reads cache; leaf edits invalidate only their ancestors. Consistency via `data_version` stamped on every response. |
| **Large facts** | Monthly range partitions on `spend_fact`, `kpi_fact`, `audit_event`; hot 13 months in Postgres, everything in BigQuery; `QueryPlanner` routes by period range and row estimate. |
| **Read path** | Redis cache keyed by `hash(query AST) + data_version + principal scope`; our own server-side row model (`/query` with cursor pagination and lazy child loading) streams pages of 200 rows to the `@budget/grid` adapter; cells drawn lazily on canvas; cursor pagination on every list API. |
| **Write path** | Idempotent commands with client-generated `command_id`; optimistic concurrency on `version_id`; transactional outbox → Pub/Sub for roll-ups, search index, notifications, BigQuery CDC. Bulk edits run as a single transaction with a preview/diff step and a size cap (10k rows per commit; larger runs go to `export-worker`-style async jobs). |
| **Search** | Own indexer and index table (§11.3); RLS applied at query time; engine swappable (Postgres FTS → self-hosted Meilisearch) behind one `SearchProvider` interface. |
| **Compute** | Stateless Cloud Run services autoscale on request concurrency; workers scale on Pub/Sub backlog; Cloud SQL with read replicas for reporting/search reads; connection pooling via Cloud SQL Auth Proxy + PgBouncer. |
| **Tenancy and fairness** | RLS per workspace; per-workspace rate limits and job quotas so one client's bulk import cannot starve another's grid. |
| **Tested limits** | CI load suite on the golden dataset scaled to 100k envelopes / 20 dimensions / 5 templates / 30M facts / 1M comments asserts p95 targets in Appendix C on every release. |
| **Extensibility** | Registry (§4.2), metric library (§4.8), policy engine (§8.1), rules engine (§8.4), search qualifiers (§11.3) and MCP tools (§6.4) all read configuration; adding a granularity or a metric appears in all six without code. |

### 5.4 OpenAI usage policy

All model calls go through a single `packages/ai` client wrapping the OpenAI API (`gpt-5` family for reasoning, `text-embedding-3-large` for embeddings). Phase 1 uses it only for two low-risk assists: (a) suggesting column→dimension mappings when a CSV/Sheet is connected, (b) drafting the human-readable summary of an approval request from its diff. Every call is logged with prompt hash and token count. No budget data is sent for model training; use the API with data-retention opt-out. Phase 2 expands to the copilot and variance narratives.

---

## 6. Integrations

### 6.1 Inbound: actuals and projections

| Source | Method | Cadence | Notes |
|---|---|---|---|
| **Snowflake** | Snowflake Node SDK, key-pair auth, read-only role on data team's `MEDIA_SPEND`, `MEDIA_KPIS` (conversions, revenue, impressions, clicks by attribution model), `MEDIA_PROJECTIONS` and `MEDIA_TARGETS` views | Every 15–60 min | The data team's formulas stay in Snowflake. We store `formula_version` per row. KPI rows land in `kpi_fact`; target rows create `target_version`s with `source='snowflake'`. |
| **Google Sheets** | Sheets API v4, service account shared on the sheet; user maps columns → dimensions once (AI-assisted) | Every 15 min or on-demand | Validation report per pull: unknown dimension values, bad numbers, duplicates. Rejected rows never enter facts. |
| **BigQuery (data team datasets)** | Direct query via service account | Every 15–60 min | Preferred over Snowflake where data already lands in GCP. |
| **CSV upload** | Drag-drop, streamed to GCS, validated, previewed, committed | Ad hoc | Same mapping UI as Sheets. |
| **Manual result entry** | Spreadsheet-style grid in the app for offline or non-integrated media (TV, OOH, DOOH, print, radio, sponsorships): pinned totals, tabs by channel, paste from clipboard | Ad hoc | Entries are drafts until **sent for approval**; the approval policy for manual actuals is separate from budget policies. Approved rows land in `spend_fact`/`kpi_fact` with `source_system = 'manual'`, the entering user and the approver as lineage. |

Every ingestion run writes `ingest_run(id, source, started_at, rows_read, rows_accepted, rows_rejected, error_report_uri)`. The UI shows a "Data freshness" indicator on every screen with the last successful run time per source.

### 6.2 Outbound: exports

- **CSV everywhere**: every grid, every report, every audit view has an Export button that respects the current filters and grouping. Async for > 50k rows (email/Slack link when ready).
- **XLSX** with frozen headers and formatting for finance.
- **Google Sheets push**: create or refresh a Sheet from a saved view (read-only tab, timestamped).
- **BigQuery**: all tables live in `budget_os_<env>` dataset via Datastream; curated views `v_budget_current`, `v_budget_vs_actual_daily`, `v_approvals`, `v_closures`. Analysts and Looker connect here.
- **Webhooks** (Phase 2): `budget.approved`, `alert.triggered`, `period.closed`.

### 6.3 Slack

- OAuth app installed in the workspace; per-workspace default channel plus per-rule channel override.
- Alert messages use Block Kit with the envelope path, pacing bar, actual vs budget vs projection, deep link. Approve/reject buttons on approval requests (Phase 2; Phase 1 links to the app).

### 6.4 Read-only MCP server

Exposes the system of record to internal AI assistants (Claude, custom OpenAI-based agents, IDE tools) **without any write capability**.

**Transport:** Streamable HTTP on Cloud Run behind IAP; per-user OAuth so RLS applies — a user's MCP session sees exactly what they see in the UI.

**Tools (all read-only, all paginated, all return `data_as_of` timestamps):**

| Tool | Purpose |
|---|---|
| `list_workspaces()` | Workspaces the caller can access |
| `describe_dimensions(workspace_id)` | Registry + values (so agents build correct filters) |
| `get_budget(envelope_id or dimension_filter, period)` | Current approved version + draft if any |
| `query_budgets(workspace_id, filters, group_by[], period_range, include_actuals, include_projection)` | The pivot API; same engine the grid uses |
| `get_pacing(filters, period)` | Actual, projected close, variance, alert state, CPA/KPI vs target |
| `query_targets(filters, metric_key, period)` | Budget and KPI targets with current versions and inheritance resolved |
| `get_timeline(filters, date_range, group_by[])` | Envelopes, targets and experiments as dated bars with pacing state, the same data the Timeline view renders |
| `list_experiments(filters, status)` / `get_experiment(id)` | Test vs control read-out, criterion, decision |
| `search(query, types[], limit)` | Same indexed search as the UI (§11.3), same qualifiers |
| `list_threads(anchor_type, anchor_id)` / `get_thread(id)` | Comments and conversations on an entity |
| `list_tags(workspace_id)` / `query_by_tag(tag, types[])` | Tag vocabulary and tagged entities |
| `list_approvals(filters, status)` | Approval requests and decisions |
| `get_decision_timeline(envelope_id)` | Full lineage of an envelope |
| `list_alerts(filters, status)` | Open/snoozed/resolved alerts |
| `get_closure(workspace_id, period)` | Locked closure snapshot |
| `export_csv(query)` | Returns a signed GCS URL |

**Resources:** `budget://workspace/{id}/registry`, `budget://workspace/{id}/closures/{period}`.

**Guardrails:** deny-list of any mutating verbs at the gateway; rate limits per principal; every call logged to `audit_event` with `actor_type = 'mcp'`; row caps with cursor pagination; no free-text SQL.

---

## 7. Users, roles and permissions

### 7.1 Roles (workspace-scoped, assignable per dimension scope)

| Role | Set budgets | Submit for approval | Approve | Manage registry / policies | Close periods | Read | Export | Connect sources |
|---|---|---|---|---|---|---|---|---|
| **Viewer** | – | – | – | – | – | ✔ | ✔ | – |
| **Planner** | ✔ (draft) | ✔ | – | – | – | ✔ | ✔ | – |
| **Budget Owner** | ✔ (draft) | ✔ | ✔ within own scope | – | – | ✔ | ✔ | – |
| **Approver** | – | – | ✔ per policy | – | – | ✔ | ✔ | – |
| **Finance** | – | – | ✔ per policy | – | ✔ | ✔ | ✔ | – |
| **Data Admin** | – | – | – | – | – | ✔ | ✔ | ✔ |
| **Workspace Admin** | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| **Org Admin** | everything, all workspaces | | | | | | | |

### 7.2 Scopes

A role assignment is `(user, workspace, role, scope)` where `scope` is a dimension filter, e.g. `{country: ["AR","BR","MX"], platform: ["meta"]}`. Empty scope = whole workspace. Scopes are evaluated by the same filter engine used for queries, so "can approve LATAM Meta budgets" is one row, and the MCP server, the grid and the approval engine all agree.

### 7.3 Separation of duties

- A user cannot approve a version they authored (configurable per policy, default on).
- Approval thresholds can require **N of M** approvers or **sequential** chains (Planner → Budget Owner → Finance above €X).
- Break-glass: Org Admin can force-approve with a mandatory reason; flagged in audit and in the Decision Timeline with a distinct marker.

### 7.4 Groups

Google Groups sync (Directory API) so role assignment can target `latam-media-leads@…` rather than individuals. Membership changes take effect within 15 minutes; removed users lose sessions immediately.

---

## 8. Financial governance (Phase 1 must-haves)

### 8.1 Approval Governance — policy as configuration

`approval_policy(workspace_id, name, priority, conditions jsonb, chain jsonb, active)`

- **Conditions** on the version diff: `amount_abs`, `amount_delta_pct`, `dimension_values` (region, channel, client), `envelope_level`, `period_days_remaining`, `is_over_allocation`.
- **Chain**: ordered steps, each `{role or group, min_approvals, timeout_hours, escalate_to}`.
- First matching policy (by priority) wins; a default policy always exists.
- Policy changes are versioned and audited; a request keeps the policy version it was evaluated under.

Example policies shipped as templates:

```yaml
- name: Minor adjustment
  conditions: { amount_delta_pct: {lt: 5}, amount_abs: {lt: 10000} }
  chain: [{ role: budget_owner, min_approvals: 1, timeout_hours: 48 }]
- name: Standard
  conditions: { amount_abs: {lt: 250000} }
  chain:
    - { role: budget_owner, min_approvals: 1, timeout_hours: 48 }
    - { role: approver, min_approvals: 1, timeout_hours: 72, escalate_to: finance }
- name: Major / over-allocation
  conditions: { any: [ {amount_abs: {gte: 250000}}, {is_over_allocation: true} ] }
  chain:
    - { role: budget_owner, min_approvals: 1 }
    - { role: finance, min_approvals: 2 }
```

### 8.2 Approval Tracking (internal & external)

- `approval_request(id, envelope_version_id, policy_version_id, requested_by, requested_at, summary, status, due_at)`
- `approval_decision(id, request_id, step_index, decided_by, decision (approve|reject|request_changes), comment, decided_at, evidence_uri, channel (app|slack|email|external_upload))`
- **External approvals** (a client signs off in an email or PDF): a Planner records an `external_approval` with the artifact uploaded to GCS, approver name, date and a hash of the document. It is displayed with an "external evidence" badge and counts toward the chain only if the policy allows it.
- Every request has a stable URL and appears in the approver's **Inbox** (in-app) and, optionally, Slack.

### 8.3 Decision Traceability / Reconstruction

The **Decision Timeline** view for any envelope (and for any roll-up) shows, in order: version created (by whom, from what), diff vs previous approved, request, each decision with comment, alerts that fired in between, actuals that arrived, closure lock. All from `audit_event` + joins; nothing depends on Slack or email history.

**Point-in-time queries:** "What was the approved budget for Brazil Meta on 14 March?" is one API call (`as_of` parameter) because versions are immutable and time-stamped.

### 8.4 Budget Pacing & Risk Management

`pacing_rule(workspace_id, scope jsonb, metric, comparator, threshold, window, severity, delivery)`

Metrics available in Phase 1 (all computed from ingested facts, none from our own forecasting):

- `spend_to_date_pct` — actual / budget
- `time_elapsed_pct` — days elapsed / days in period
- `pace_index` — spend_to_date_pct / time_elapsed_pct (1.00 = on pace)
- `projected_close_pct` — projection / budget (from data team's formula)
- `projected_variance_abs` — projection − budget
- `unmatched_spend_pct` — data quality guard
- `days_to_exhaust` — at current 7-day run rate
- `kpi_vs_target_pct` — actual KPI (CPA, CPL, ROAS…) / target, direction-aware (§4.8)
- `kpi_trend_7d` — 7-day KPI vs previous 7 days
- `implied_volume_gap` — projected conversions vs volume implied by budget ÷ CPA target
- `efficiency_adjusted_pace` — pace index × (actual CPA / target CPA), flags "on budget but buying badly"

Default rules shipped: over-pace > 1.10 for 3 consecutive days (warning), projected close > 105% (critical), projected close < 85% with < 30 days left (warning), CPA > 110% of target for 3 consecutive days (warning), CPA > 125% of target (critical), implied volume gap > 15% (warning), unmatched spend > 2% (data). Rules are inherited down the tree unless overridden, and every rule can be scoped by any dimension filter, tag or owner.

Alerts have lifecycle `open → acknowledged → snoozed → resolved` with owner, and de-duplicate per envelope+rule while open.

### 8.5 Notification System (nice-to-have but cheap → we ship a minimal version in Phase 1)

Phase 1: in-app inbox + Slack channel posts for critical alerts and approval requests, plus @mention and thread-reply notifications (§8.6). Phase 2: per-user preferences, digests, email, interactive Slack approvals.

### 8.6 Comments, conversations and tagging

The changelog tells you *what* changed; the conversation tells you *why*. Both live on the entity.

**Where you can comment**
- Any envelope, any specific version, any target, any approval request, any alert, any closure, any dimension value.
- Any **cell**: an envelope × month intersection ("why is November front-loaded?").
- On a **version diff**: comment on a specific changed field.

**How threads behave**
- A thread has a status (open / resolved) and an optional title; resolving is audited and reversible.
- Comments support Markdown, attachments (GCS), `@user`, `@group` (Google Groups), `#envelope-path` cross-references that render as live chips with the current amount and status, and `/target`, `/alert`, `/request` references.
- Edits keep history; deletes are soft. Comments are part of the Decision Timeline, interleaved chronologically with versions, approvals, alerts and ingestion events, so reconstruction reads like one story.
- **Subscriptions**: authors, mentioned people, envelope owners and approvers of the current request are auto-subscribed; anyone can follow an envelope or a tag. Notifications in-app and (Phase 1) Slack DM for mentions; digests in Phase 2.
- **Slack bridge (Phase 2)**: a thread can be mirrored to a Slack thread; replies on either side sync, and the Slack copy carries the deep link back.
- **Search and filters**: comment bodies are indexed (§11.3); filters include "has open threads", "mentions me", "commented in last 7 days".
- **Approval integration**: a "request changes" decision opens a thread automatically; the request cannot be re-submitted while it has unresolved *blocking* threads (a flag the approver sets).

**Tags (labels)**
- Free-form, workspace-scoped vocabulary with colour and kind (`label`, `status`, `team`, `custom`). Examples: `black-friday`, `client-requested`, `pending-po`, `test-budget`, `hold`.
- Attach to envelopes, targets, requests, alerts, comments, saved views. Bulk tag from any grid selection.
- Tags are first-class in filters (`tag:pending-po`), search qualifiers, pacing rule scopes, saved views and the MCP tools.
- Governance: anyone can apply existing tags; creating new tags can be restricted to Workspace Admins to keep the vocabulary clean. Merge/rename with history.

**Permissions**: read a thread if you can read the entity; comment if you can read (configurable to "Planner and above"); resolve if you are the author, the entity owner or an approver on it. Viewers from another client never see threads outside their scope (RLS on `thread.anchor`).

---

## 9. Budget Planning & Financial Management

### 9.1 Documentation of Media Spend Data (must-have)

Every envelope version carries: amount, currency, rationale (free text, required above threshold), attachments (GCS), tags, links to briefs/tickets (Jira/Confluence via URL). Actuals are stored with source lineage (§4.4). Together this is the structured, version-controlled record linked to the approval workflow.

### 9.2 Forecasting & Scenario Planning (Phase 2)

Scenarios are alternate budget trees (`amount_type = scenario`) on the same envelopes; users compare side-by-side, promote a scenario to draft, then to approval. Projection deltas recompute from ingested projections by scaling with the data team's agreed elasticity assumptions, or via a Snowflake stored procedure they own.

### 9.3 Editability: dynamic budgets, moving targets (must-have)

Budgets and targets move all the time. The rule is **everything is editable, nothing is lost, and small edits are fast**.

| Capability | Behaviour |
|---|---|
| **Inline edit** | Amount, target value, name, owner, dates, phasing, dimension values, tags, rationale — directly in the grid cell or drawer field. Enter commits, Esc cancels, Tab moves on. Optimistic UI with conflict detection (§4.3). |
| **Versions on every numeric change** | Budget and target edits always create a version; metadata edits create audit events. Both show in the changelog with actor, time, before/after and reason. |
| **Free drafts, gated approvals** | Drafts are visible to the author and anyone they share them with; they never affect approved numbers or pacing until approved. Policies (§8.1) decide what needs approval: below-threshold changes can auto-approve so a €500 tweak doesn't wait 48 hours. |
| **Bulk edit** | Select any rows (or a whole filter result) → apply: absolute set, ± amount, ± %, redistribute a parent proportionally / evenly / by last period's actuals / by a pasted weight column, copy from previous period, scale to a new parent total. Always with a **preview diff** and a single commit that becomes one approval request. |
| **Paste from spreadsheet** | Paste a range from Sheets/Excel onto a selection; columns mapped by header; validation report before commit. Round-trip: export CSV → edit → import with diff. |
| **Re-phase** | Drag month-by-month phasing bars or type amounts; total locked or unlocked per the user's choice. |
| **Re-parent / split / merge** | Move an envelope under another parent, split one into several, merge several into one; lineage kept; caps re-validated; approvals re-routed if the policy changes. |
| **Change dates** | Extend, shorten or shift an envelope's date range; actuals re-match automatically; pacing recomputes. |
| **Retarget** | Change a CPA or budget target with a reason; historical pacing keeps the target that applied at the time (point-in-time semantics). |
| **Restore** | Any prior version can be restored with one action (creates a new version, never rewrites history). |
| **Undo** | Session-level undo/redo for uncommitted draft edits. |
| **Formula envelopes (Phase 2)** | Derived budgets (`= 12% of parent`, `= last year × 1.1`) recomputed when inputs change; the formula is stored on the version. |
| **Locks** | Only closures lock. Approval never blocks a new draft; a pending request blocks a *second* concurrent request on the same envelope unless the first is withdrawn. |

Scale guard: bulk operations over 10k rows run asynchronously with progress and a downloadable result report; over 100k rows must be done through the CSV import path.

---

## 10. Reporting & Decision Support

### 10.1 Budget Reporting (must-have)

Reports are **saved views** over the same query engine, not a separate module:

- Budget vs Actual vs Projected, any grouping, any period, with variance columns and pacing bars.
- Approval status report (pending, overdue, rejected).
- Closure report per quarter (frozen).
- Data quality report (match coverage, freshness, rejected rows).

Delivery: on screen, CSV/XLSX, scheduled Sheets refresh, BigQuery views for Looker. PDF export of closure report in Phase 2.

### 10.2 Query engine

One service, `QueryPlanner`, turns `{filters, group_by[], measures[], period_range, as_of}` into SQL against Postgres (live) or BigQuery (history > 13 months or > 200k rows). Both the grid and the MCP `query_budgets` call it. Results cached in Redis keyed by query hash + data version.

---

## 11. Functional UX requirements and frontend stack

Visual design (layout, typography, colour, component styling) is owned by the design team and is out of scope for this document. This section specifies **behaviour** the design must support and the React stack that implements it.

### 11.1 Behavioural principles (where we beat Camphouse)

1. **Grid-first, but readable.** Frozen path columns, indent by hierarchy level, collapsible groups, sticky totals row, density toggle. Pacing shown as an inline bar with a projected-close tick, not a number to interpret.
2. **Filters that stick.** Filter/group/sort state lives in the URL and in saved views. Sharing a link shares the exact slice.
3. **Inline first, drawer second, modal never** (except destructive confirmations). Edit an amount in the cell; the right-hand drawer shows version history, timeline and comments without leaving the grid.
4. **Status is visible at every level.** Approval chips on parents summarize children (e.g. "3 pending"); open-thread and alert indicators likewise.
5. **Keyboard-complete.** Arrow navigation, Enter to edit, Esc to cancel, `⌘K` / `/` opens global search from anywhere.
6. **Approver's workflow is an inbox**, not a search: what needs me, sorted by due date, with the diff, the conversation and the pacing context in one place.
7. **Glanceable risk.** Overview = pacing by market × platform, KPI vs target, top variances, alerts, data freshness. Zero configuration required to be useful.
8. **Explain, don't decorate.** Every colour has a legend; every derived number has a tooltip with its formula and `data_as_of`.
9. **Budget and target on the same row.** Wherever a budget shows, its CPA/KPI target and actual can be toggled on as columns.

### 11.2 Filters: exact and free

One filter model, shared by Explorer, Pivot, Alerts, Approvals, Reports, saved views, pacing-rule scopes and the MCP `query_*` tools. It is a typed query AST (zod schema in `packages/domain`) compiled to SQL by `QueryPlanner`.

**What can be filtered**

| Family | Fields |
|---|---|
| Dimensions | every registry dimension, default or custom, including hierarchical values ("everything under EMEA") |
| Money | budget, actual, projected, variance (abs and %), remaining, phasing month amount |
| Targets | metric, target value, actual KPI, KPI vs target %, has target / missing target |
| Time | fiscal period, custom `start–end`, relative (`current quarter`, `last 30 days`, `next 90 days`, `year to date`), **as-of** (point in time), comparison period |
| Status | draft / pending / approved / locked / archived; approval step; overdue; alert severity and state |
| People | owner, approver, requested by, mentions me, commented by |
| Metadata | tag, source system, currency, has attachments, has open threads, created/updated in range |

**Operators** (per field type): `is`, `is not`, `in`, `not in`, `contains`, `starts with`, `is empty`, `is not empty`, `between`, `>`, `<`, `≥`, `≤`, `descends from` (hierarchy), `within` (relative dates).

**Composition**: AND across groups, OR within a group, nested groups; negate a group. Filter chips are editable in place; the advanced editor shows the tree.

**Granularity controls are separate from filters**: group-by path (tree), roll-up level, show/hide leaves, pivot rows/columns/measures, period grain (day / week / month / quarter). Changing granularity never changes the filter, and vice versa.

**Persistence**: URL-encoded (shareable), saved views (personal, shared with users/groups, or workspace default), recent filters, and "pin filter to workspace" for standing constraints (e.g. a market team sees only its market by default). Saved views can be tagged and searched.

### 11.3 Global search: indexed, GCP-console style

One search box, always visible, opened with `⌘K` or `/`. Behaviour modelled on the Google Cloud console search:

- **As you type**: results grouped by resource type with counts — Envelopes, Targets, Approvals, Alerts, Comments, Tags, Dimension values, Saved views, Reports, Data sources, People, Admin pages. Top 5 per group, "See all N in Envelopes →" opens the Explorer pre-filtered.
- **Structured qualifiers**, autocompleted with values from the registry: `type:envelope`, `country:BR`, `platform:meta`, `objective:non_brand`, `status:pending`, `owner:@me`, `approver:@me`, `tag:black-friday`, `period:2026-Q4`, `budget:>1000000`, `cpa:>target`, `has:open-thread`, `mentions:@me`, `updated:<7d`. Custom dimensions become qualifiers automatically (`retailer:carrefour`).
- **Free text** matches names, paths, rationales, comment bodies, tag names, dimension labels and aliases, request IDs (`AR-2041`) and external IDs (a Meta account ID pastes straight in).
- **Fuzzy and prefix**: `brazl meta conv` finds "Brazil › Meta › Conversions".
- **Recents and pins** per user; keyboard navigation; Enter opens the top result; `⇧Enter` opens in the Explorer as a filter.
- **Result rows are informative**: an envelope row shows path, period, approved amount, status chip and pace index; an approval row shows delta and due date.
- **Deep links** carry the filter so search → list → row is one flow.
- **Scoped**: RLS applies; a user only sees results they could open.

**Index design**

```sql
search_document (
  id, workspace_id, entity_type, entity_id,
  title text, path text, body text, tags text[],
  dimension_values jsonb, numeric_facets jsonb,     -- budget, actual, cpa, pace_index for qualifiers
  owner_id, status, period_id, updated_at,
  tsv tsvector GENERATED,                            -- weighted: title A, path B, tags B, body C
  trigram text                                       -- for pg_trgm prefix/fuzzy on title+path
) PARTITION BY LIST (workspace_id)
-- indexes: GIN(tsv), GIN(trigram gin_trgm_ops), GIN(dimension_values), (workspace_id, entity_type, updated_at)
```

- Maintained by `search-indexer` from the transactional outbox: every entity write, tag change, comment and registry change emits an index event; p95 index lag target < 5 s.
- Phase 1 engine: Postgres FTS + `pg_trgm` on a read replica. Behind a `SearchProvider` interface so the engine can move to a self-hosted Meilisearch (MIT) container on Cloud Run when documents exceed ~5M or p95 exceeds 150 ms; the indexer already emits documents in a shape Meilisearch accepts.
- Phase 2: semantic search over rationales and comments with OpenAI embeddings stored in `pgvector`, blended with lexical results.
- The same index powers `@mention` and `#envelope` autocompletion in comments and the qualifier suggestions in filters.

### 11.4 Screens (Phase 1, functional inventory)

| Screen | Purpose |
|---|---|
| **Home** | "Waiting on you" (approvals, mentions, alerts) first; pacing strip per top-level scope (target · approved · actual · projected); recents; data freshness; guided tour entry (§11.7) |
| **Overview** | Pacing by market × platform, KPI vs target, top over/under, open alerts, approvals due |
| **Budgets (Explorer)** | Hierarchical grid + pivot, exact filters, inline and bulk edit, targets as columns, export |
| **Timeline** | Gantt of envelopes, targets and experiments on the fiscal calendar (§4.11); same filters as Explorer; as-of scrubber |
| **Envelope drawer** | Amount + targets + versions + changelog + threads + attachments + child allocation + phasing |
| **Approvals inbox** | Requests needing me (budgets, targets, manual actuals); diff, context, conversation, decide |
| **Targets** | Target grid by scope and metric; inheritance; import/sync |
| **Experiments** | Test list, test vs control read-out, decisions (§4.12) |
| **Alerts** | Table + rule editor (scopes by filter/tag) |
| **Search** | Global search overlay and full results page |
| **Closures** | Period list, close wizard, frozen report |
| **Data sources** | Connections (card gallery with prerequisites and status), mapping, run history, unmatched queue, **manual result entry** |
| **Admin / Settings** | See §11.6 |

### 11.5 React stack: real libraries, no bespoke UI kit

| Concern | Library | Why |
|---|---|---|
| Framework | React 19 + Vite + TypeScript | Standard |
| Routing | TanStack Router | Type-safe search params → URL-persisted filters for free |
| Server state | TanStack Query | Caching, optimistic inline edits |
| Client state | Zustand | Small, explicit |
| Components | **shadcn/ui** (Radix primitives) + Tailwind CSS, themed with the design team's tokens | Accessible, unopinionated, fast to ship |
| Data grid | **Glide Data Grid** (MIT, canvas) as the rendering engine, wrapped in `@budget/grid`; TanStack Table for column state; see §11.9 | Canvas rendering scales to millions of rows with editing, selection, copy/paste and custom cells built in. We add the server-side row model, tree, pivot matrix, budget-specific editors and bulk tooling. |
| Timeline / Gantt | **SVAR React Gantt open-source core** (MIT) wrapped in `@budget/timeline`; fallback **vis-timeline** (Apache-2.0/MIT) or custom canvas; see §11.9 | Virtualised task tree, zoom, hierarchy and drag come from the core; target/experiment lanes, markers, fiscal axis and the as-of scrubber are ours. PRO features are never used. |
| Chip template builder | dnd-kit + cmdk | Naming templates (§4.10), hierarchy templates (§4.2), qualifier builder (§11.3) share one component |
| Guided tours | driver.js (MIT) | Product tours and feature spotlights (§11.7) |
| Spreadsheet export | exceljs (MIT) for XLSX; CSV streamed server-side | No SheetJS Pro |
| Search engine | Postgres FTS + pg_trgm first; **Meilisearch** (MIT) self-hosted on Cloud Run as the swap target (§11.3) | Open-source engine, one container, typo tolerance and faceting out of the box |
| Licence policy | All dependencies MIT / Apache-2.0 / BSD; CI runs `license-checker` and fails on anything else, including any `@svar/*` PRO or other paid scope | Enforces principle 9 |
| Search UI | cmdk + custom qualifier tokenizer | Command-palette interaction, grouped results |
| Charts | Recharts for simple; visx for the pacing/burn micro-charts inside cells | |
| Forms | react-hook-form + zod (shared schemas from `packages/domain`) | One validation source for UI and API |
| Rich text | TipTap core + open-source Mention extension (MIT), custom #reference node | Comments with @mentions and #references; no TipTap Pro extensions |
| Tables (light) | TanStack Table | Inbox, alerts, audit |
| Dates | date-fns + `@internationalized/date` | Fiscal calendars, relative ranges |
| Icons | Lucide, plus uploaded SVGs for custom dimensions | |
| Testing | Vitest, Testing Library, Playwright | |

### 11.6 Admin and Settings information architecture

Camphouse's settings cover the right ground but as one long, unsearchable list. Ours is grouped by **who owns the setting**, searchable (the global search indexes settings pages and individual options), and split between organization and workspace scope with inheritance shown inline ("inherited from org — override").

| Group | Owner | Contents |
|---|---|---|
| **Organization** | Org Admin | General (name, logo, default currency, fiscal calendar), Workspaces (clients / subsidiaries / business units — create, archive, inherit settings), Users & groups (Google Groups sync, SSO), Roles & scopes, Security (session policy, MCP tokens, API keys, IP allow-list), Audit log export |
| **Taxonomy** | Workspace Admin (org defaults by Org Admin) | Dimension registry (dimensions, values, icons, nesting), Hierarchy builder & templates, Value constraints, Naming templates (display + match key), Tags vocabulary, Metric library |
| **Governance** | Workspace Admin / Finance | Approval policies (budgets, targets, manual actuals), Separation-of-duties options, Closure settings (who closes, restatement rules), Exchange rates (source, overrides, history) |
| **Pacing & alerts** | Budget Owner / Workspace Admin | Pacing rules, default thresholds, alert routing, quiet hours |
| **Data** | Data Admin | Sources (Snowflake, BigQuery, Sheets, CSV, manual entry) as a card gallery with prerequisites and connection status, Column/dimension mappings, Match rules, Run schedules, Unmatched queue defaults, Retention |
| **Integrations** | Workspace Admin | Slack (channels, DM rules), Webhooks (Phase 2), MCP access per group |
| **Views & defaults** | Workspace Admin | Workspace default saved view, pinned filters per team, default hierarchy template, default period grain, home layout |
| **AI** | Org Admin | OpenAI usage toggles per feature, data-sharing policy display, suggested questions library for the copilot |
| **Personal** | Every user | Profile, notification preferences, locale/number format, keyboard shortcuts, my saved views, my tours |

Every settings change is versioned and audited; policy-type settings (approval policies, pacing rules, naming templates, registry) keep version history visible on the page with a diff and "restore".

### 11.7 Home and onboarding (Ease of Use)

The "Barrier of Entry" must-have is served by four things:

1. **Home is a to-do list, not a feed.** "Waiting on you" (approvals, mentions, alerts assigned to me, unmatched rows in my scope) first; then a pacing strip per top-level scope I own (target · approved · actual · projected, with pace index); then recents and pinned views. Empty states explain the next action.
2. **Guided tours.** A first-run tour per role (Planner, Approver, Finance, Data Admin) in 5–7 steps, re-launchable from Help; feature spotlights when something new ships; tours are configurable by Org Admins so agencies can add their own process notes. Completion is tracked per user as an adoption metric.
3. **Templates.** A new workspace starts from a template: default registry, a hierarchy template, default policies and pacing rules, a sample saved view, and an optional demo dataset that can be wiped in one click.
4. **Help in place.** Every derived number has a formula tooltip; every disabled action states why it is disabled and what would enable it; every settings page links to its section of the runbook; `?` opens a searchable shortcut and help panel.

Phase 2 adds the copilot panel on Home with a suggested-questions library, each question mapped to an MCP tool call so answers are always grounded in the same data as the grid.

### 11.8 Accessibility and i18n

WCAG 2.2 AA. All grid interactions reachable by keyboard. Numbers formatted per user locale; currency codes always visible. UI strings externalized (English first; Spanish and Portuguese in Phase 2).

### 11.9 Grid and timeline: adopt open source, build the delta

No commercial components. The two highest-effort front-end pieces are built as internal packages wrapping mature MIT-licensed cores, so we own the budget-specific behaviour without re-implementing rendering engines. Both packages live in the monorepo with a storybook, a benchmark suite and API docs, owned by the frontend platform engineer.

#### `@budget/grid` on Glide Data Grid

**What the core gives us (MIT):** canvas rendering with lazy cell drawing that scales to millions of rows, native scrolling, built-in cell editing overlays, single/multi-select of cells, rows and columns, resizable and movable columns, variable row heights, merged cells, fully custom cell renderers, and copy/paste. TanStack Table supplies column state and sorting metadata alongside it.

**What we build:**

| Capability | Approach |
|---|---|
| Server-side row model | Glide asks for cells by `[col, row]`; our adapter maps row indices to pages fetched from `POST /query` (filter AST, group-by path, sort, cursor, expanded paths) and fills cells as pages arrive. Children load lazily on expand. `data_version` on every page triggers a silent refetch of visible pages when stale. |
| Tree | Indent, chevrons and "3 pending" roll-up chips as a custom path cell; expand/collapse toggles re-query; expanded state saved in the view. Sticky group rows via variable row heights. |
| Pivot | Computed server-side by `QueryPlanner`, returned as a flat matrix with column metadata; rendered by the same adapter. No client-side pivoting. |
| Budget cells | Custom renderers: money with currency and tabular numerals, pacing bar with projected-close tick, status/thread/alert chips, target-vs-actual cell. |
| Editors | Glide overlay editors for money (currency-aware), percent, date, dimension picker with search, tag picker, rich text for rationale; Enter/Esc/Tab semantics; optimistic commit through TanStack Query with conflict rollback (§4.3). |
| Bulk and clipboard | Glide's range selection and paste events feed our preview-diff flow (§9.3); fill-down and the bulk-edit toolbar are ours. |
| Totals and frozen columns | Pinned totals rows (top/bottom by preference) as fixed rows; frozen path columns via Glide's `freezeColumns`. |
| Export | CSV streamed from the API; XLSX via exceljs in a Web Worker for ≤ 50k rows, server job above that. |
| Accessibility | Glide's built-in keyboard navigation and screen-reader support, plus our labelled DOM twins for custom cells. |

**Explicitly not built in Phase 1:** in-cell charts beyond the pacing bar, right-to-left, print layouts.

#### `@budget/timeline` on SVAR React Gantt (MIT core)

**What the core gives us:** virtualised rendering for thousands of tasks, hierarchical task tree with a configurable grid on the left, zoomable time scales (hours to weeks, extended by us to months/quarters/FY), task progress fill, drag-and-drop for dates (used in Phase 2), dependencies, keyboard interaction, React 19 support.

**What we build (all PRO-only features in SVAR are re-implemented, never licensed):**

| Capability | Approach |
|---|---|
| Data adapter | Envelopes, targets and experiments from `GET /timeline` mapped to SVAR tasks; target lanes as child rows of type `target`, experiments as type `experiment`; lazy loading on expand through the same server-side row model as the grid. |
| Fiscal axis | Custom scale definitions from the workspace fiscal calendar (FY › quarter › month › week) and holiday/key-date columns. |
| Bar templates | Custom task templates: spend fill proportion, projected-close tick, pacing colour, overlap stacking for targets, hatching for experiment evaluation windows. |
| Markers | Approval, alert, closure and comment icons drawn in an overlay layer positioned by the Gantt's scale API; clustering when dense; click opens the drawer. (Markers are a PRO feature in SVAR, so this is ours.) |
| Today line and as-of scrubber | Overlay line plus a draggable date handle that re-queries with `as_of` and reloads tasks; the grid pane updates in sync. |
| Read-only mode | Drag disabled in Phase 1; Phase 2 enables SVAR's drag/resize and routes the change into a draft version. |
| Fallback | If SVAR's core proves too opinionated, the adapter targets vis-timeline (Apache-2.0/MIT) or a custom canvas renderer; the adapter boundary keeps screens unchanged. |

**Phase 0 spike (weeks 1–2):** build both packages against the golden dataset at 100k envelopes / 5k visible bars and measure against the Appendix C targets before committing; record the outcome in ADR-002 (grid) and ADR-003 (timeline).

**Performance targets:** 60 fps scroll in the grid at 100k envelopes; 5k bars render in < 500 ms p95; first paint of a region-filtered 100k-envelope workspace in < 1.5 s.

#### Effort

Adopting the two cores brings the build down to roughly 5–7 engineer-weeks for the grid and 4–6 for the read-only timeline, against 10–14 and 6–8 if built from headless primitives. Risks: upstream abandonment (both are actively maintained today; we vendor the packages and can fork), and feature creep toward PRO-gated features (mitigated by the licence check and the rule in principle 9).

---

## 12. Data quality and AI-readiness

We want to answer, in 2027, "how close were we to budget, where, why — and can a model predict the miss?" That requires today:

1. **Immutability**: versions and closures never mutate (§4.3, §4.5).
2. **Lineage**: every fact has `source_system, source_run_id, formula_version`; every budget has actor and reason.
3. **Consistent keys**: dimension codes are canonical and mapped to platform IDs via `external_ids`; renames are new labels on the same code.
4. **Time semantics**: `period_date` (when spend happened), `loaded_at` (when we learned it), `as_of` queries (what we believed at the time). This triple is what lets a model avoid look-ahead bias later.
5. **Feature-ready tables in BigQuery**: `f_budget_vs_actual_daily` (leaf grain, one row per envelope per day: budget, cumulative actual, projection, pace_index, alerts_open, approvals_pending, days_to_period_end). Built in Phase 1, used in Phase 3.
6. **Quality SLOs tracked as product metrics**: match coverage ≥ 99%, freshness ≤ 60 min, rejected rows reviewed within 1 business day, zero orphan approvals.
7. **Golden datasets**: a fixed synthetic workspace used in CI to assert totals, roll-ups and closures never drift.

---

## 13. Roadmap

Sizing assumes an internal core team of 1 PM, 0.5 designer (design owned by the design team), 4 full-stack engineers (TS), 1 frontend platform engineer (grid and timeline owner), 1 data engineer, part-time security/platform. All development is internal; no contractors, no commercial components; mature MIT-licensed libraries are adopted wherever they fit (§3.9). Adjust weeks, not scope order.

### Phase 0 — Foundation (weeks 1–6)

**Epic 0.1 Program setup**
`/goal` This document is approved by product, engineering, data and finance leads; a decision log exists and is used.

**Epic 0.2 GCP landing zone**
`/goal` `dev`, `staging`, `prod` projects exist via Terraform with Cloud Run, Cloud SQL (private IP), BigQuery dataset, Secret Manager, IAP+Identity Platform SSO; a "hello" service deploys through CI in < 10 minutes.

**Epic 0.3 Monorepo and domain package**
`/goal` `packages/domain` contains zod schemas for every entity in §4 and the permission matrix in §7; `packages/db` has the Prisma schema and a migration that creates all tables with RLS enabled; golden synthetic dataset seeds locally.

**Epic 0.4 Dynamic dimension registry and hierarchy builder**
`/goal` An admin can create a custom dimension with its own icon, add nested values, declare parent/child relationships by drag-and-drop, and build several hierarchy templates, all without a deploy; the default registry (§4.2) is seeded; the API rejects any envelope whose dimension tuple violates the registry; a newly added dimension appears as a filter, group-by, search qualifier and MCP parameter within 10 seconds.

**Epic 0.5 Frontend shell and design handoff**
`/goal` shadcn/ui + Tailwind consume the design team's tokens; app shell (nav, workspace switcher, global search entry point) built against the design team's specs; the behavioural contract in §11.1–11.3 is reviewed and accepted by the design team.

**Epic 0.6 Query AST and filter engine**
`/goal` The typed filter AST (§11.2) is defined in `packages/domain`, compiled by `QueryPlanner`, and covered by property-based tests; every operator on every field family works against the golden dataset; the same AST is accepted by the API and the MCP server.

**Epic 0.7 Grid package (`@budget/grid` on Glide Data Grid)**
`/goal` Spike concluded and ADR-002 written by week 2; the package renders tree and pivot data from the server-side row model with frozen path columns, pinned totals, budget cell renderers, inline editors for every field type, range selection, clipboard paste with preview, keyboard navigation and CSV/XLSX export; the benchmark suite shows 60 fps scroll and p95 interaction < 200 ms at 100k envelopes on the golden dataset; a storybook documents every public prop; the dependency licence check passes.

**Epic 0.8 Timeline package (`@budget/timeline` on SVAR React Gantt core)**
`/goal` Spike concluded and ADR-003 written by week 2 (SVAR core, vis-timeline or custom canvas); the package renders envelope, target and experiment bars against a fiscal axis with zoom, custom bar templates, our own marker overlay, today line and as-of scrubber; read-only in Phase 1; 5k bars render in < 500 ms p95; no PRO-scoped package appears in the dependency tree.

### Phase 1 — Must-haves (weeks 7–24)

**Epic 1.1 Envelopes, versions, allocation** *(Single Source of Truth, Documentation of Media Spend Data)*
`/goal` Users create a budget tree for a workspace and any date range, edit amounts and monthly phasing inline, re-parent/split/merge envelopes with lineage, see the full changelog of any envelope, and cannot approve children whose sum exceeds the parent; conflicting concurrent edits are detected; every write emits an audit event.

**Epic 1.1b Editability and bulk operations** *(Ease of Use, dynamic budgets)*
`/goal` Bulk edit (set / ± / % / redistribute / copy previous period / scale to total) with preview diff works on any grid selection or filter result; paste-from-spreadsheet and CSV round-trip import produce a validated diff before commit; restore-any-version works; below-threshold edits auto-approve per policy; 10k-row bulk commit completes in < 10 s.

**Epic 1.1c Targets: budget and KPI (CPA, ROAS, …)**
`/goal` Users set budget and KPI targets on envelopes or filters, targets are versioned and optionally approval-gated, parent targets inherit to children with visible overrides, CPA/KPI actuals flow from `kpi_fact`, implied volume and KPI-vs-target show in the grid, and targets import from Sheets and sync from Snowflake with a validation report.

**Epic 1.2 Roles, scopes, groups** *(Security)*
`/goal` Google SSO works; role assignments with dimension scopes are enforced by RLS in Postgres and by the API for every route; separation of duties blocks self-approval; a permission-matrix test suite passes for all roles × actions.

**Epic 1.3 Approval engine** *(Approval Governance, Approval Tracking)*
`/goal` Policies configured as in §8.1 route requests through the correct chain; approvers act from the Inbox; external approvals with evidence can be recorded; a request keeps its policy version; overdue requests escalate.

**Epic 1.4 Decision Timeline and point-in-time** *(Decision Traceability)*
`/goal` Any envelope or roll-up shows a full timeline from audit data alone; `GET /budgets?as_of=YYYY-MM-DD` returns exactly the approved amounts at that instant; a reconstruction test replays 12 months of synthetic history and matches expected totals.

**Epic 1.5 Ingestion: Snowflake, BigQuery, Sheets, CSV**
`/goal` Actuals, KPIs (conversions, revenue, impressions, clicks) and projections from all four sources land in `spend_fact`/`kpi_fact`/`projection_fact` with lineage; ≥ 99% match coverage on the pilot workspace; unmatched queue is usable; freshness indicator on every screen.

**Epic 1.6 Pacing engine and alerts** *(Budget Pacing & Risk Management, minimal Notification System)*
`/goal` Default pacing rules, including CPA-vs-target and implied-volume-gap rules, evaluate every 15 minutes; rules can be scoped by any filter or tag; alerts open/ack/snooze/resolve; critical alerts, approval requests and @mentions post to Slack with deep links; no duplicate alerts per envelope+rule.

**Epic 1.7 Budget Explorer grid and exact filters** *(Ease of Use, Scalability)*
`/goal` `@budget/grid` renders tree + pivot over 100k envelopes with p95 interaction < 200 ms; every filter family and operator in §11.2 works, including hierarchical, relative-date and as-of filters; granularity controls independent of filters; filters/grouping persisted in URL and saved views (personal, shared, workspace default); approval, thread and alert chips on every level; targets toggleable as columns.

**Epic 1.7b Global search** *(Ease of Use)*
`/goal` `⌘K` search returns grouped results across all entity types in §11.3 with structured qualifiers autocompleted from the registry, fuzzy/prefix matching, recents and deep links; index lag p95 < 5 s; query p95 < 150 ms at 1M documents; results respect RLS; the same `search` tool is exposed over MCP.

**Epic 1.7c Comments, conversations and tags**
`/goal` Threads can be opened on every anchor type in §8.6 including cells and diff fields; @user/@group mentions and #envelope references autocomplete and notify; threads resolve and appear in the Decision Timeline; "request changes" opens a blocking thread; tags apply singly or in bulk and work in filters, search, rule scopes and MCP.

**Epic 1.7d Timeline (Gantt) view for budgets and targets**
`/goal` Using `@budget/timeline`, any Explorer filter set opens as a Gantt on the fiscal calendar grouped by any dimension path; envelope bars show spend fill and projected-close position; target lanes render budget and KPI targets with overlaps and the effective target at any date; approval, alert, closure and comment markers and an as-of scrubber work; 5k bars render at p95 < 500 ms.

**Epic 1.7e Manual result entry with approval**
`/goal` Users enter offline/non-integrated actuals in a spreadsheet grid tabbed by channel, paste from clipboard, see pinned totals, and send for approval; approved rows land in `spend_fact`/`kpi_fact` with entering user and approver as lineage; disabled actions always state why.

**Epic 1.7f Naming templates and match keys**
`/goal` Admins build display-name and match-key templates from dimension chips with separators and casing rules and see a live preview; envelope titles regenerate on label changes; ingestion matches by external ID, then match key, then manual, and records `match_method` on every fact.

**Epic 1.7g Experiments**
`/goal` Users create an experiment with hypothesis, test and control scopes, metric and success criterion; test envelopes are ordinary envelopes linked to it; the Experiments screen shows test vs control KPIs side by side and requires a decision comment to conclude; experiments appear as a Timeline lane and a search qualifier.

**Epic 1.7h Home, guided tours and workspace templates**
`/goal` Home shows "waiting on you" before anything else and a pacing strip per owned scope; role-based first-run tours exist for Planner, Approver, Finance and Data Admin and are re-launchable; a new workspace can be created from a template with registry, policies, rules and optional demo data; tour completion is tracked; settings are searchable from the global search.

**Epic 1.8 Reporting and exports** *(Budget Reporting)*
`/goal` Budget vs Actual vs Projected report at any grouping; CSV/XLSX export from every grid respecting filters; Sheets push of a saved view; curated BigQuery views documented and used by the data team.

**Epic 1.9 Closures**
`/goal` A Finance user closes a quarter through a wizard; envelopes lock; the closure partition lands in BigQuery; restatement requires admin + reason; the closure report is frozen and exportable.

**Epic 1.10 Read-only MCP server**
`/goal` `mcp-readonly` on Cloud Run exposes the tools in §6.4 behind per-user OAuth; an internal assistant can answer "what is the approved Q4 budget for Mexico across platforms and how is it pacing" with correct numbers; no mutating tool exists; every call is audited.

**Epic 1.11 Overview dashboard**
`/goal` Pacing heatmap (market × platform), top 10 variances, open alerts, approvals due and data freshness render in < 1.5 s for the pilot workspace with zero configuration.

**Epic 1.12 Pilot and hardening**
`/goal` One global client workspace runs a full month in production in parallel with sheets; variance between system totals and finance's numbers is explained to the cent; security review and pen test closed; runbooks written; adoption ≥ 80% of planners on that account.

**Epic 1.13 Scale validation**
`/goal` The CI load suite (§5.3) at 100k envelopes / 20 dimensions / 5 templates / 30M facts / 1M comments meets every Appendix C target; adding a dimension, a metric or 10k tags causes no schema change and no measurable regression.

**Phase 1 exit criteria:** all `/goal` lines above green; the must-have capabilities in the requirements matrix (Appendix A), including the 0.2 additions, each map to at least one passing acceptance test.

### Phase 2 — Nice-to-haves (weeks 25–36)

**Epic 2.1 Forecasting & Scenario Planning**
`/goal` Users create scenarios on a budget tree, compare up to 3 side-by-side with projected outcomes, and promote one to draft for approval; scenario math is owned by the data team's Snowflake procedures.

**Epic 2.2 Notification System (full)**
`/goal` Per-user preferences (in-app, Slack DM, email), daily digests, interactive Slack approve/reject, quiet hours; delivery success ≥ 99.5%.

**Epic 2.3 Process Automation**
`/goal` Rules engine automates: auto-approve within policy, auto-carry-forward of unspent budget to next period, auto-create alerts on ingestion anomalies, scheduled exports and Sheets refreshes; every automated action is audited as `actor_type = 'system'`.

**Epic 2.4 Copilot (OpenAI)**
`/goal` A chat panel answers questions over the user's permitted data via the same MCP tools, drafts approval summaries and variance explanations, and never writes; hallucination guard: every number in an answer links to a query result.

**Epic 2.5 Timeline editing, PDF closure report, webhooks, ES/PT localization**
`/goal` Envelopes and targets can be moved and resized by drag on the Timeline (creating draft versions), scenario overlays and dependency lines render; closures export as PDF; webhooks fire for approved/closed/alert; UI available in Spanish and Portuguese.

**Epic 2.6 Formula envelopes and target rules**
`/goal` Derived budgets and targets (`= 12% of parent`, `= last year × 1.1`, `CPA target = blended CPA × 0.9`) recompute when inputs change, store their formula on the version, and route through approval like any edit.

**Epic 2.7 Conversation extensions**
`/goal` Threads mirror to Slack threads bidirectionally; per-user notification preferences and digests; semantic search over rationales and comments (OpenAI embeddings in pgvector) blended with lexical results.

### Phase 3 — Intelligence (later, depends on 2+ closed quarters)

**Epic 3.1 Variance analytics**
`/goal` `f_budget_vs_actual_daily` powers a variance model that explains misses by dimension; results reviewed by the data team before any UI exposure.

**Epic 3.2 Recommendations**
`/goal` Suggested reallocations with confidence and rationale, always routed through the human approval chain.

---

## 14. Team and ways of working

- **Product owner** holds this document. Changes via PR with a one-line entry in §15.
- **Coding agent** works from `BUDGET_OS_BUILD_SPEC.md` §22 in order, one task per PR, under the rules in `AGENTS.md`. A human reviews every PR; the agent never merges.
- **Spec drift rule:** if implementation requires deviating from the build spec, the agent writes an ADR and updates the spec in the same PR; the plan is updated only when scope or requirements change.
- **Weekly**: roadmap review against `/goal` lines (green/amber/red).
- **Definition of done** for an epic: `/goal` demonstrated in staging on the golden dataset, docs updated, audit events verified, CSV export works, MCP parity checked where relevant.
- **Architecture Decision Records** in `docs/adr/` — first six: Postgres vs Firestore, ADR-002 grid core (Glide Data Grid vs TanStack-only build), ADR-003 timeline core (SVAR MIT core vs vis-timeline vs custom canvas), NestJS vs Fastify, Datastream vs custom CDC, Snowflake connector auth.

---

## 15. Decision log

| Date | Decision | Rationale | Owner |
|---|---|---|---|
| 2026-09-23 | Postgres (Cloud SQL) as system of record; BigQuery for history/analytics | ACID + RLS for tenancy; BQ for scale and AI later | [ARCH] |
| 2026-09-23 | Ingest, never re-compute, the data team's projections | Formulas already exist; avoid two truths | [PM] |
| 2026-09-23 | ~~AG Grid Enterprise for the Explorer~~ **Superseded 0.4** | — | — |
| 2026-09-23 | No commercial components or paid libraries; internal development only | Company policy | [PM] |
| 2026-09-23 | Adopt MIT-licensed cores and build the delta: Glide Data Grid for the grid, SVAR React Gantt open-source core for the timeline, Meilisearch as search swap target; PRO/paid tiers never used | Halves the in-house UI effort (~9–13 engineer-weeks instead of 16–22) while keeping zero licence cost; adapters keep both swappable | [PM/ENG] |
| 2026-09-23 | OpenAI only for all LLM work | Company policy | [PM] |
| 2026-09-23 | Minimal Slack notifications pulled into Phase 1 | Cheap, and pacing alerts are useless without delivery | [PM] |
| 2026-09-23 | MCP server is read-only, per-user OAuth, separate service | Security boundary; parity with UI permissions | [SEC] |
| 2026-09-23 | Visual design owned by the design team; this plan specifies behaviour only | Stakeholder decision | [PM] |
| 2026-09-23 | Targets (budget and KPI) share one versioned model with an admin-extensible metric library | CPA next to budget everywhere; no schema change per metric | [ARCH] |
| 2026-09-23 | KPI actuals in long-format `kpi_fact`; derived KPIs computed at query time | Correct weighted roll-ups; new metrics without migrations | [DATA] |
| 2026-09-23 | Search on Postgres FTS + pg_trgm behind a `SearchProvider` interface | Fast to ship, one less system; swappable at scale | [ARCH] |
| 2026-09-23 | Dimension registry supports custom dimensions, icons, nested values and multiple hierarchy templates from Phase 0 | Granularity is the product's core; retrofitting is expensive | [PM/ARCH] |
| 2026-09-23 | Comments/threads are part of the audit surface and the Decision Timeline | "Why" belongs next to "what" | [PM] |
| 2026-09-23 | Timeline (Gantt) view for envelopes and targets moves to Phase 1 (read-only); drag-edit in Phase 2 | Stakeholder priority; targets are dated objects | [PM] |
| 2026-09-23 | Manual result entry with its own approval policy added as a source | Offline media has no integration path otherwise | [PM/DATA] |
| 2026-09-23 | Naming template builder adopted for display names and match keys only; no UTM generation | Consistency and matching without scope creep | [ARCH] |
| 2026-09-23 | Experiments modelled as ordinary envelopes linked to an experiment record | Test spend stays governed | [PM] |
| 2026-09-23 | Guided tours, role-based home and workspace templates are Phase 1 | Ease of Use is a must-have | [PM] |

---

## 16. Open questions

1. Which workspace is the pilot client? Needs global footprint and a willing finance partner.
2. Reporting currency and FX source (ECB daily? finance's table?).
3. Fiscal calendar: calendar quarters or client-specific fiscal years? Both must be supported; which first?
4. Snowflake: which views, who owns the read-only role, what is the SLA on projection refresh?
5. Do external client approvals need e-signature, or is uploaded evidence sufficient for finance?
6. Google Groups vs manual role assignment for the pilot?
7. ~~AG Grid licence~~ Resolved 0.4: built in-house.
8. Data retention policy for audit events (proposal: indefinite in BigQuery, 24 months hot in Postgres).
9. KPI actuals: which conversion definitions and attribution models does the data team expose, and at what granularity? CPA targets are only as good as the conversion count under them.
10. Should target changes be approval-gated by default, or free with audit only? Proposal: free below ±10%, gated above.
11. Tag governance: open vocabulary or admin-curated? Proposal: curated per workspace, with a "propose tag" flow.
12. Which entity types must be searchable at launch beyond the list in §11.3 (e.g. ingestion runs, audit events)?
13. Formula envelopes: does finance want them at all, or does it prefer explicit numbers only?
14. "Tests" as used by stakeholders: confirmed as test budgets / experiments (§4.12)? Or something else (approval test mode, A/B of policies, QA)?
15. Which offline channels need manual result entry at launch (TV, OOH, DOOH, print, radio, sponsorship), and who approves manual actuals: the market lead, finance, or both?
16. ~~Timeline component buy vs build~~ Resolved 0.5: SVAR React Gantt MIT core behind an adapter, confirmed by the Phase 0 spike (ADR-003). Grid core likewise Glide Data Grid (ADR-002).

---

## Appendix A — Requirements matrix (from capability screenshots)

| Capability | Priority | Phase | Sections | Epics |
|---|---|---|---|---|
| Approval Governance | Must | 1 | §8.1 | 1.3 |
| Approval Tracking (internal & external) | Must | 1 | §8.2 | 1.3 |
| Decision Traceability / Reconstruction | Must | 1 | §8.3, §4.6 | 1.4 |
| Budget Pacing & Risk Management | Must | 1 | §8.4 | 1.6 |
| Notification System | Nice | 1 (minimal) / 2 (full) | §8.5, §6.3 | 1.6, 2.2 |
| Documentation of Media Spend Data | Must | 1 | §9.1, §4.3–4.4 | 1.1, 1.5 |
| Forecasting & Scenario Planning | Nice | 2 | §9.2 | 2.1 |
| Budget Reporting | Must | 1 | §10 | 1.8 |
| Single Source of Truth | Must | 1 | §3, §4 | 1.1 |
| Scalability | Must | 1 | §5, §10.2, §11.3 | 1.7, 0.2 |
| Barrier of Entry (Ease of Use) | Must | 1 | §11 | 1.7, 1.11, 0.5 |
| Process Automation | Nice | 2 | — | 2.3 |
| *Added in 0.2 (stakeholder requirements)* | | | | |
| Everything editable, dynamic budgets, bulk edit | Must | 1 | §9.3, §4.3 | 1.1, 1.1b |
| Budget **and** KPI/CPA targets | Must | 1 | §4.8, §8.4 | 1.1c, 1.6 |
| Exact filters (date, granularity, status, people, tags) | Must | 1 | §11.2 | 0.6, 1.7 |
| Indexed global search, GCP-style | Must | 1 | §11.3 | 1.7b |
| Comments, conversations, @mentions, tags | Must | 1 | §8.6, §4.9 | 1.7c |
| Dynamic granularities, custom dimensions and icons | Must | 0 | §4.2 | 0.4 |
| Scalability (validated) | Must | 1 | §5.3, App. C | 1.13 |
| Target and budget timelines (Gantt) | Must | 1 | §4.11 | 1.7d, 2.5 |
| Manual result entry with approval (offline media) | Must | 1 | §6.1 | 1.7e |
| Naming templates / match keys | Must | 1 | §4.10 | 1.7f |
| Experiments (test budgets) | Must (to confirm) | 1 | §4.12 | 1.7g |
| Home, guided tours, workspace templates, searchable settings | Must | 1 | §11.6, §11.7 | 1.7h |
| Grid and timeline on MIT cores, no commercial components | Must (policy) | 0 | §3.9, §11.9 | 0.7, 0.8 |

## Appendix B — API surface (Phase 1, REST + OpenAPI)

```
GET    /workspaces
GET    /workspaces/{id}/dimensions
POST   /workspaces/{id}/dimensions                      (admin; icon upload via /assets)
POST   /dimensions/{id}/values ; PATCH /values/{id} ; POST /values/{id}/merge
GET    /workspaces/{id}/hierarchy-templates ; POST /workspaces/{id}/hierarchy-templates
GET    /workspaces/{id}/metrics ; POST /workspaces/{id}/metrics       (metric library)
POST   /workspaces/{id}/query                           body: filter AST + group_by + measures + period + as_of
GET    /workspaces/{id}/envelopes?filters&group_by&period&as_of
POST   /workspaces/{id}/envelopes
PATCH  /envelopes/{id}/draft                            → new envelope_version (draft)
PATCH  /envelopes/{id}/phasing
POST   /envelopes/{id}/move | /split | /merge           → envelope_lineage
POST   /envelopes/bulk                                  body: selection or filter + operation → preview_id
POST   /envelopes/bulk/{preview_id}/commit
POST   /envelopes/{id}/submit                           → approval_request
GET    /targets?filters&metric ; POST /targets ; PATCH /targets/{id}/draft ; GET /targets/{id}/versions
GET    /search?q=&types=&limit=                         (qualifiers parsed server-side)
GET    /threads?anchor_type&anchor_id ; POST /threads ; POST /threads/{id}/comments ; POST /threads/{id}/resolve
GET    /tags ; POST /tags ; POST /tags/apply            body: tag_id + entities[]
GET    /saved-views ; POST /saved-views
GET    /timeline?filters&date_range&group_by          → bars for envelopes, targets, experiments
GET    /experiments ; POST /experiments ; POST /experiments/{id}/conclude
GET    /naming-templates ; POST /naming-templates ; POST /naming-templates/{id}/preview
POST   /manual-entries                                   body: rows → draft batch ; POST /manual-entries/{batch_id}/submit
GET    /settings/search?q=                               settings pages and options
GET    /tours ; POST /tours/{id}/complete
POST   /workspaces                                       body: template_id → seeded workspace
GET    /approvals?status&assignee=me
POST   /approvals/{id}/decisions
POST   /approvals/{id}/external-evidence
GET    /envelopes/{id}/timeline
GET    /pacing?filters&period
GET    /alerts ; PATCH /alerts/{id}
GET    /rules ; POST /rules
GET    /sources ; POST /sources ; POST /sources/{id}/run ; GET /sources/{id}/runs
GET    /unmatched-spend ; POST /unmatched-spend/{id}/map
POST   /closures ; GET /closures/{period}
POST   /exports  → { job_id } ; GET /exports/{job_id}
```

## Appendix C — Non-functional requirements

| Area | Target |
|---|---|
| Scale | 50+ workspaces, 100k+ envelopes/workspace, 20+ dimensions (custom included), 100M facts/year, 1M+ comments, 5M+ search documents |
| Latency | Grid queries p95 < 400 ms (API), < 200 ms interaction (UI); search p95 < 150 ms; inline edit commit p95 < 300 ms; 10k-row bulk commit < 10 s |
| Freshness of derived data | Roll-up cache and search index lag p95 < 5 s after a write |
| Registry changes | New dimension/value/metric visible in filters, group-by, search and MCP in < 10 s, zero downtime |
| Availability | 99.9% business hours across regions |
| Freshness | Actuals ≤ 60 min behind source |
| Security | SSO only, RLS tenancy, secrets in Secret Manager, annual pen test, SOC2-aligned controls |
| Audit | 100% of writes produce an audit event; audit replicated to BigQuery within 5 min |
| Backups | PITR 7 days, daily snapshots 35 days, quarterly restore drill |


## Appendix D — Agent build kit

This plan is written for people. Two companion files make it executable by a coding agent of any size:

| File | Role | Who edits it |
|---|---|---|
| `docs/BUDGET_OS_MASTER_PLAN.md` (this file) | What and why. Requirements, data model, architecture, roadmap with `/goal` lines. | Product owner |
| `docs/BUDGET_OS_BUILD_SPEC.md` | How. Repo layout, pinned versions, Prisma schema and SQL migrations, zod schemas (FilterGroup, QueryRequest/Response, permissions, errors), planner code, command handlers, HTTP controller map, frontend routes and components, workers, Terraform, golden dataset, and the ordered task list (§22) with a "Done when" per task. | Tech lead; agents via PR |
| `AGENTS.md` | Rules of the road for agents: reading order, commands, non-negotiables, workflow, definition of done, PR template, lookup table, anti-patterns. | Tech lead |

**Precedence:** spec code > spec prose > plan > agent judgement. Deviations require an ADR in `docs/adr/`.

### D.1 Why a cheap model can build this

Small models fail on ambiguity, not on difficulty. The kit removes decisions rather than explaining them:

1. **Every shape exists once**, as a zod schema in `@budget/domain`; API, workers, web and MCP import it. An agent never invents a request body.
2. **Every table exists once**, in `packages/db`; RLS, audit and outbox are helpers (`withTenant`, `audit`, `outbox`) with fixed signatures.
3. **Every task is small and closed**: ≤ 12 files, one spec section, a named migration if any, and a "Done when" that is a test in the PR (spec §22.1). Order of execution is stated.
4. **Starting code is given** for the hard parts (planner compile, tenancy wrapper, grid adapter, timeline adapter, approval matcher, ingestion pipeline). The agent extends; it does not design.
5. **Defaults are written down** for everything an agent would otherwise guess: ids, money, time, errors, logging, folder layout, naming, disabled-with-reason, licence allowlist.
6. **Guardrails are mechanical**: `license-check`, `no-restricted-imports`, MCP read-only guard test, permission-matrix test, golden-dataset assertions, benchmark baselines. Wrong answers fail CI instead of relying on the model's care.
7. **Anti-patterns are enumerated** (AGENTS.md §9): the plausible-but-wrong moves a generic model makes in this domain.

### D.2 Rules for keeping the kit unambiguous

- A plan change that alters a shape, table, route or rule is not done until the spec and, if relevant, AGENTS.md are updated in the same PR.
- New work enters as a spec §22 task using the template in §22.1. If a task cannot be written with a testable "Done when", the requirement is not ready.
- Spec code blocks are contracts: names, signatures and paths are kept. Improving them is allowed only with an ADR and a migration path.
- Golden dataset first: any new entity gets deterministic seed rows and a totals assertion before UI work starts.
- Benchmarks before adoption: every performance-sensitive component (grid, timeline, planner, search) has a baseline committed and a spike task with an ADR (0.7 / 0.8).

### D.3 Model-agnostic prompting for a task

Give the agent this and nothing else:

```
Read AGENTS.md. Then do task T-0xx from docs/BUDGET_OS_BUILD_SPEC.md §22.
Follow the spec sections the task cites. Write the "Done when" test first.
Open a PR using the template in AGENTS.md §7. Do not start another task.
```
