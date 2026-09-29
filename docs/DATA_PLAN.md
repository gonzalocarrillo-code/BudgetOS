# Data plan: history, external sources and budget import

Product feedback, round 8 (2026-09-28). Five questions from the product owner, each answered with what exists, what to decide, and what to build. Tasks are in §5; decisions for the owner in §6. §7 and §8 were added the same day: what the MCP server tells an AI, and where snapshots live and how tenants stay apart. Status rows live in `docs/TASKS_STATUS.md`.

Related: `docs/BUDGET_HISTORY_PLAN.md` and ADR-053 (snapshots), ADR-042 (warehouse routing), ADR-011 (ingestion), ADR-018 (closures in BigQuery), spec §14 and §24.3 (sources, mapping and matching).

## 1. History: BigQuery or Cloud Storage?

**The short answer.** Cloud Storage keeps files. BigQuery answers questions. History that anyone will ask about, in the app, through MCP or in Looker, belongs in BigQuery. History that is only kept, such as the raw files a client sent and export archives, belongs in Cloud Storage. Snapshots are app data and stay in Postgres, replicated like every other table.

### 1.1 What exists

| Store | Holds today | Notes |
|---|---|---|
| Postgres | Everything the app writes: budgets, versions, approvals, snapshots, audit, spend and KPI facts (monthly partitions) | The system of record. RLS, audit and the outbox live here. |
| BigQuery | Closure reports, one table per period (ADR-018); a dataset with curated views (`v_budget_current`, `v_budget_vs_actual_daily`, `v_approvals`, `v_closures`) | The views read replica tables that **do not exist yet**: the Datastream stream is the plan's phase 20 and is not built. Heavy grouped queries route to BigQuery when `BIGQUERY_DATASET` is set (ADR-042), and find nothing. |
| Cloud Storage | Uploaded CSVs (ingestion), export files with signed URLs, database backups | Files only. |
| The client's warehouse | Their spend, KPIs and projections, read-only | BudgetOS ingests what it needs; the full history stays there. |

### 1.2 Decision

- **Postgres stays the truth, with the last 13 months of facts hot.** That is the plan's own rule, and the planner already routes by it.
- **Datastream replicates every Postgres table into BigQuery** (`budget_os_<env>`): budgets, versions, snapshots and their rows, audit, facts. This is the one piece missing, and it turns the existing views and routing on. Facts older than 13 months are then pruned from Postgres by a retention job, and the planner reads them from BigQuery.
- **Snapshot rows replicate too**, so "plan versus close over three years" runs in BigQuery, and the Snapshots page and MCP keep reading Postgres for the live compare.
- **Cloud Storage keeps the raw ingested files** (what a client sent, as sent, for audit and re-runs) and export archives. Retention per workspace.
- **Not this:** a second application store in BigQuery, or snapshots kept only as files. Both were rejected with the analytics-only decision of 2026-09-27.

### 1.3 Dependencies

A GCP project with Datastream and a Cloud SQL private-IP connection. Until then, everything above works on Postgres alone, and BigQuery keeps only the closure tables.

## 2. External sources: one client says tCPA, another says CPA

**The short answer.** The mapping layer already does this in two places. A source maps its columns to dimensions and to roles, with a value map from the client's codes to the registry's. The org's metric library says what CPA is, and each org can name it. What is missing is reuse: a saved mapping profile per client, and synonyms so the wizard guesses right the second time.

### 2.1 What exists

- **Column mapping, per source** (`SourceMapping`, spec §14). A column is a dimension (with `valueMap`: raw value to registry code, e.g. "Facebook Ads" to `meta`), or a role: `period_date`, `amount`, `currency`, `kpi` with a metric name, `projection`, `match_key`, `ignore`.
- **A guesser and an AI suggestion.** The wizard reads the header and the first rows, guesses each column by name and values, and can ask `@budget/ai` to suggest a mapping from a sample. Nothing is saved until the person accepts.
- **The metric library, per org** (`metric_definition`, plan §4.8). A metric is a numerator over a denominator, each `spend`, `budget` or `kpi:<fact metric>`, with a multiplier and a label. CPA is `spend / kpi:conversions`. Admins add or rename metrics with no deploy, so one org's CPA is another's tCPA.
- **External IDs on dimension values** (`external_ids`, e.g. `meta_account_id`) and **match keys** with a parse pattern (§24.3), so facts match budgets by name when the client has no tuple columns.
- **Rejected rows and unmatched spend** are reported per run, never guessed.

### 2.2 The rule that makes it work

Sources deliver **counts, never ratios**: spend, conversions, revenue, impressions. A CPA column cannot be rolled up, because a sum of ratios means nothing. BudgetOS derives every ratio at query time from the counts, at every level of the tree. If a client can only give a ratio, it is ingested as a leaf-only metric flagged non-additive, the way reach is, and never summed.

### 2.3 Decision

- **Mapping profiles.** A named, saved mapping an org reuses across sources, uploads and re-uploads: the same client file maps the same way every time. A source points at a profile, or carries its own mapping as today.
- **Synonyms feed the guesser.** A per-org list that says `tcpa`, `target_cpa` and `cpa_target` all mean the metric `cpa`, and `Facebook Ads` means `meta`. Seeded with common platform names, and learned from every mapping a person accepts.
- **A contract view per client.** Ask each client's data team for one view per warehouse with canonical column names (`v_budget_os_spend`, `v_budget_os_kpis`). The mapping layer still handles everything, but the wizard then maps it in one click.
- **Validation before ingestion.** The wizard's preview runs the mapping against the sample and shows what each column becomes, which values are unknown, and which metrics the org has no definition for.

## 3. A predictable CSV import for budgets

**The short answer.** Today a CSV only edits existing budgets: export a selection, change the amount, import back by budget id, approve. Nothing creates budgets or a hierarchy from a file. The fix is a template the app generates from the workspace's own registry, a validation report, and a preview before anything is written.

### 3.1 What exists

- **The round trip** (`csv-export`, `csv-import`, plan §9.3): the export writes `envelope_id, path, currency, approved_amount, amount`; the import needs `envelope_id` and `amount`, reports bad lines, and opens the bulk preview. Every change is a draft under one approval.
- **The New budget dialog and Add child** create budgets one at a time. Workspace templates create the registry, policies and rules for a new workspace, not budgets.
- **Spend ingestion** already has the shape the budget import needs: upload, per-line validation report, then a run.

### 3.2 The file

The app generates the template from the workspace's registry, so the columns are never a guess:

| Column | Required | Meaning |
|---|---|---|
| one column per active dimension (`country`, `platform`, …) | at least one | Codes or labels; resolved through the registry |
| `name` | no | Defaults to the naming template's display name |
| `parent_key` | no | For free structures (ADR-049): the `key` of another row, or an existing budget's id |
| `key` | no | A row's own handle for `parent_key` |
| `currency` | yes | ISO code |
| `amount` | yes | Plain decimal, two places |
| `start_date`, `end_date` | yes | ISO dates |
| one column per month (`2026-01` …) | no | Phasing; must sum to `amount` |
| `envelope_id` | no | Present: the row edits that budget instead of creating one |
| `rationale` | no | Kept in the history |

Rules: headers match dimension keys or labels, case-insensitive. Unknown values fail the line and suggest the nearest registry value; admins can create the value from the report. One row per leaf. Parents come from the dimension tuple under the chosen hierarchy template, created or matched per level, unless `parent_key` says otherwise.

### 3.3 The flow

1. **Download the template** from Budgets › Import, with the registry's columns and two example rows.
2. **Upload.** The per-line validation report lists every problem with its line, like spend ingestion.
3. **Preview.** New budgets, matched budgets that become amount changes, parents to create, and the total. Nothing is written yet.
4. **Commit as drafts** under one approval, like a paste. The file never applies directly (AGENTS §9: a file only ever produces drafts).
5. **Re-import is safe.** A row matching an existing budget by its tuple and dates, or by `envelope_id`, is an edit, so the same file twice changes nothing.

## 4. Where snapshots live and how they are reached

Asked with round 8: snapshots must be stored and accessible.

- **Stored** in Postgres (`budget_baseline`, `budget_baseline_row`), never deleted, replicated to BigQuery with everything else once Datastream exists (§1).
- **Reached** on the Snapshots page (list, open, rename, archive, restore, compare in Budgets, download CSV), in the budget drawer, in Overview and Closures, over the API (`/baselines`, `/baselines/:id/rows`, `/baselines/:id/export.csv`), and over MCP (`list_baselines`, `get_baseline`, `compare_budgets`).

## 5. Tasks

| Phase | ID | Task | Done when |
|---|---|---|---|
| F1 | D-001 | Datastream: Terraform stream from Cloud SQL to `budget_os_<env>`, every table; the views test reads the replica | The curated views return rows in staging; `/query` routes a 24-month grouped query to BigQuery and matches Postgres |
| F1 | D-002 | Retention job: prune facts older than 13 months from Postgres after they are confirmed in BigQuery; raw files to Cloud Storage with per-workspace retention | Golden: a 26-month fact set reads the same totals before and after the prune |
| F1 | D-003 | Snapshot rows and audit in the replica; `v_snapshots` view | A plan-versus-close query over two fiscal years runs in BigQuery |
| F2 | D-004 | Mapping profiles: `mapping_profile` rows, a source points at one, the wizard offers "save as profile" and "use profile" | A second upload from the same client maps with no edits |
| F2 | D-005 | Synonyms: per-org column and value synonyms, seeded and learned from accepted mappings; the guesser and the AI prompt read them | `tcpa` maps to `cpa` on the first guess |
| F2 | D-006 | Mapping preview: what each column becomes, unknown values, metrics with no definition | The report lists the sample's problems before any run |
| F3 | D-007 | Budget import template: generated from the registry, with example rows | Downloaded file re-imports with no errors |
| F3 | D-008 | Budget import: upload, validation report, preview, commit as drafts under one approval; parents from the tuple or `parent_key`; `envelope_id` edits | Golden: a 50-row file creates the tree, the same file again changes nothing |
| F3 | D-009 | Import UI in Budgets, Playwright | Playwright |

## 6. Decisions for the product owner

| # | Decision | Proposal |
|---|---|---|
| F1 | Is a GCP project with Datastream available now? | Yes, or F1 waits and everything runs on Postgres. |
| F2 | Does BudgetOS need more than 13 months of spend at all, given the client's warehouse keeps it? | Keep 13 months hot, the rest in BigQuery once F1 exists. |
| F3 | Ratio-only KPI feeds | Accepted as leaf-only, non-additive metrics; counts preferred. |
| F4 | Budget import for people who are not admins | Planners import into their scope; a file that touches budgets outside it fails those lines. |
| F5 | Import creates missing registry values? | Admins only, from the validation report, one click per value. |

## 7. What the MCP server tells an AI, and how to tell it more

The question: how much context does the MCP server expose, and how can it expose more, so an orchestrator answers well about channels, budgets, tCPA, totals, hierarchies and countries?

### 7.1 What exists

Seventeen read-only tools. Every call is authenticated as the person, cut to their scope by RLS, rate-limited, and written to the audit log. The tools cover:

- **Structure:** `list_workspaces` (workspaces, roles, permissions), `describe_dimensions` (every dimension, its values and the hierarchy templates), the `registry` resource.
- **Numbers:** `query_budgets` (the planner: any filter, any grouping, budget, spend, projection, pace, KPIs against targets, as of a date, compared with a snapshot), `get_pacing`, `get_budget`, `query_targets`.
- **History:** `list_baselines`, `get_baseline`, `compare_budgets`, `get_decision_timeline`, `get_closure`.
- **Work:** `list_approvals`, `list_alerts`, `list_threads`, `list_tags`, `search`, `export_csv`.

So the raw material is there. What an AI lacks is **orientation**: it has to make four or five calls before it knows what "channel" means in this workspace, which metric is called tCPA here, what the fiscal year is, and what the headline numbers are. Tool descriptions say what a tool does, not what this workspace holds.

### 7.2 What to add

1. **`describe_workspace`, one call for the whole picture.** The workspace's name, reporting currency, fiscal calendar and today's period; every dimension with its value count and its top values by budget (so "channel" and "country" are known words with known values); the hierarchy templates; the metric library with each metric's label, formula and direction (so tCPA is understood as this org's CPA); the headline for the fiscal year (budget, spend to date, pace, projected close, as Overview shows them); counts (budgets, leaves, countries, platforms, open approvals, open alerts); the snapshots and the latest close; data freshness. Everything it returns exists today behind five or six tools; this puts it in one answer, sized for a prompt.
2. **Server instructions.** The MCP handshake carries an `instructions` text. Ours will say: call `describe_workspace` first; filters use FilterGroup over the registry's keys and codes; amounts are reporting-currency decimal strings; "budget" means the top-level budgets and their subtrees; snapshots compare through `compareTo`; never guess a code, read it from the registry.
3. **A glossary resource** (`budget://workspace/{id}/glossary`): the org's own words. Dimension labels and their synonyms, metric labels (tCPA, ROAS), status words, what a snapshot, a close and an ended budget are. Fed by the same synonym list the mapping wizard uses (§2.3), so a word learned from a client's file is a word the AI knows.
4. **Richer tool descriptions**, generated per workspace where the SDK allows: `query_budgets` lists this workspace's dimension keys and metric keys in its schema descriptions, not a generic sentence.
5. **MCP prompts** for the common asks: "pacing review for {period}", "what moved since {snapshot}", "where is spend without a budget". Each is a fixed sequence of the tools above, with the numbers pulled live.
6. **Bigger answers in fewer calls:** `query_budgets` gains `includeTotalsByDimension` (one call returns the grouping and the totals per other dimension), and `get_budget` returns its subtree's headline.

Read-only stays the rule: nothing here writes, and the import guard keeps it so.

## 8. Snapshots in Postgres, and keeping tenants apart

### 8.1 Is Postgres the right place for snapshots and history?

Yes. This is the standard split, and the reasons apply here:

- **Snapshots are records the application writes and reads in transactions.** Saving one writes the header, its rows, an audit event and an outbox row together, or not at all. Postgres gives that. BigQuery has no transactions across tables and no row-level security in the form we rely on.
- **They are small and joined often.** One row per budget per snapshot, a few hundred to fifty thousand rows, joined to live budgets on every compare. That is an index lookup in Postgres and a scan in BigQuery.
- **They must obey the same access rules as budgets.** RLS on `workspace_id`, the caller's read scope on the granularities, the MCP role's SELECT-only grant. Those live in Postgres; BigQuery would need them rebuilt.
- **History that is already immutable stays where it is.** Versions are never updated, audit is append-only, snapshot rows are written once. Nothing about them changes by moving them.

BigQuery's job is analytics: long ranges, many rows, Looker, the data team. It gets snapshots, versions and audit by **replication** (§1, Datastream), never as a second place the app writes to. Two writers would be the duplication you asked about. What would be a mistake: snapshots only in BigQuery (no transactions, no RLS, slow compares), or written to both (drift).

### 8.2 No duplication, no cross-referencing

What holds today:

| Guarantee | How |
|---|---|
| A snapshot belongs to one workspace | `budget_baseline.workspace_id` is not null; RLS on the table; the save runs inside `withTenant` for that workspace only |
| A snapshot row belongs to its snapshot's workspace | The capture SQL selects `WHERE e.workspace_id = <the snapshot's workspace>`, so a row can only come from the same tenant; `budget_baseline_row.workspace_id` is not null with RLS |
| A budget appears at most once per snapshot | Primary key `(baseline_id, envelope_id)` |
| Snapshots never reference each other by accident | Every compare takes two ids and checks both belong to the caller's workspace before any join; the join is on `baseline_id`, never on names or codes |
| No copy of what versions already hold | A row keeps the frozen amount and structure and a `version_id` pointing at the immutable version; nothing else is copied |
| Readers see only their tenant | RLS for the app role; the MCP role has SELECT on these tables and nothing else; the read scope cuts rows by the granularities they were saved with |
| Deleting a workspace deletes its snapshots | The purge job removes `budget_baseline_row` and `budget_baseline` with the other tenant tables |

What to add so the database, not only the code, refuses a cross-tenant row:

1. **Composite foreign keys.** `budget_baseline_row (baseline_id, workspace_id)` references `budget_baseline (id, workspace_id)`, and `(envelope_id, workspace_id)` references `envelope (id, workspace_id)`. A row whose workspace differs from its snapshot's or its budget's cannot be inserted, whatever the code does.
2. **An isolation test in the RLS suite.** Two workspaces, a snapshot in each; from workspace B: the list does not show A's, `GET /baselines/{A}` is 404, compare with `against={A}` is 404, `compareTo: {baselineId: A}` in a query is 404, and the MCP role reads nothing of A. The same for a superadmin acting inside B.
3. **In BigQuery**, one dataset per environment and **authorized views per workspace** for anyone outside the app (analysts, Looker), so the replica never exposes another tenant's rows either.
4. **A weekly integrity check** (worker): every snapshot row's workspace equals its snapshot's and its budget's; every snapshot's `row_count` and total match its rows; report a mismatch as an alert to superadmins. It should never fire; it is there so a bug shows up in days, not in an audit.

## 9. Tasks added with §7 and §8

| Phase | ID | Task | Done when |
|---|---|---|---|
| F4 | D-010 | `describe_workspace` MCP tool and server `instructions` | An AI given only the instructions answers "what channels do we have and how are they pacing" in two calls |
| F4 | D-011 | Glossary resource fed by the synonym list; per-workspace tool descriptions | The glossary lists tCPA for an org that named it so |
| F4 | D-012 | MCP prompts: pacing review, since a snapshot, unmatched spend | Tools test runs each prompt end to end |
| F5 | D-013 | Composite foreign keys on `budget_baseline_row`; the two-workspace isolation test | An insert with a foreign workspace is refused by Postgres; every cross-tenant read is 404 |
| F5 | D-014 | BigQuery authorized views per workspace | An analyst account sees one workspace's rows only |
| F5 | D-015 | Weekly snapshot integrity check | The check runs on the golden workspace and finds nothing |
