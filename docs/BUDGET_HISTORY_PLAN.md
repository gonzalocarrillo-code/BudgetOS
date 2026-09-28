# Budget OS — Phase E: baselines, budget history and "how much did it move?"

Date: 2026-09-28. Follows `docs/UX_AUDIT_AND_ADMIN_PLAN.md` (Phases A–D, merged). Status: proposal.

## 0. The question, and the short answer

The product owner wants three numbers for any budget and period, and the differences between them:

1. **The plan** — what the budget was at a meaningful moment, e.g. October 1st when the quarter started.
2. **The working budget** — what it is now, being edited and re-approved all the time.
3. **The closed budget** — what it ended up being when the month or quarter was closed.

And then: "how much do budgets move between plan and close, and where?" — asked in the app and through the MCP server.

**The short answer: the history is already there. What is missing is names for moments, a way to compare against them, and the questions.**

- Every approved amount is an immutable `envelope_version` row with `approved_at` and `superseded_at`. Nothing is ever updated in place (AGENTS §4).
- The query planner already answers "budget as of an instant" (`QueryRequest.asOf`): the latest version approved by that time. The Budgets timeline has an as-of scrubber on it today.
- A closure already locks the period and freezes its report and registry versions (ADR-018).

So nothing needs to be copied to "keep history", and real-time editing does not change: a baseline is a **named timestamp**. The work is (a) a small table that names moments, taken automatically at period start and period close and by hand, (b) one planner extension that computes a second budget at that timestamp in the same query, (c) a compare control on the screens, and (d) three MCP tools. Section 3 explains the one place where a pure timestamp is not enough (structure and granularities are not versioned) and the one thing worth writing down at capture time.

---

## 1. What exists, precisely

| Capability | Where | Notes |
|---|---|---|
| Immutable approved amounts with time | `envelope_version(status, approved_at, superseded_at)` | Index `(envelope_id, status, approved_at)` makes as-of lookups cheap. Drafts are `DRAFT`, never counted. |
| "Budget as of T" | `packages/query-planner/src/compile-query.ts:91-104` | `v.status IN ('APPROVED','SUPERSEDED') AND v.approved_at <= T`, latest wins. Any measure (budget, remaining, pace) can be computed at T. |
| As-of in the product | Budgets URL `asOf`, the timeline scrubber, MCP `get_envelope(asOf)` | `query_budgets` (MCP) does not take `asOf` yet. |
| Per-budget history | Drawer › History (`features/history`), `GET /envelopes/:id/versions`, MCP `get_decision_timeline` | Versions with who / when / why, plus approvals and comments. |
| Period close | `period_closure`, `closure_envelope`, the `ClosureSink` (BigQuery in production, memory locally), `variance_summary` | Freezes every template's roll-up rows and the registry versions; locks envelopes; restate reopens. |
| Alternate budget trees | `AmountType.SCENARIO` (plan §9.2, Phase 2) | Not built; not needed for history. |

**What is not versioned:** an envelope's granularities (`envelope_dimension`), its parent (`envelope.parent_id`), its name and its dates. An as-of query gives the right *amounts* at T but groups and names them **as they are today**. If LATAM MX was moved under a different parent, or a budget's country was changed, after October 1st, "the October 1st plan by country" computed purely from timestamps would be grouped by today's country. Closures already had to deal with this: they freeze their rows.

---

## 2. Design

### 2.1 Vocabulary

| Term | Meaning |
|---|---|
| **Baseline** | A named moment for a period: "Q4 plan (1 Oct)", "September close". Rows in `budget_baseline`. Taken by the system at period start and at closure, or by an admin ("Take a baseline now"). Never edited; archived, not deleted. |
| **Plan** | The baseline at the start of the period (kind `period_open`). The default "compare to" on every screen. |
| **Working budget** | The live approved amounts (what every screen shows today). |
| **Close** | The baseline the closure creates (kind `period_close`). For a closed period, "close vs plan" is the number finance asks for. |
| **Movement** | `working − baseline` (absolute and %), per budget, per roll-up node and per period. Never stored as a KPI; computed by the planner like CPA is. |

### 2.2 Data model

```prisma
/// A named moment a period's budgets are compared against (Phase E, ADR-053).
model BudgetBaseline {
  id            String   @id @db.Uuid
  workspaceId   String   @map("workspace_id") @db.Uuid
  name          String                                   // "Q4 2026 plan", "September 2026 close"
  kind          String                                   // period_open | period_close | manual
  periodKey     String   @map("period_key")              // FY2026, 2026-Q4, 2026-10 (the workspace calendar)
  asOf          DateTime @map("as_of") @db.Timestamptz   // the instant; amounts are the versions approved by then
  closureId     String?  @map("closure_id") @db.Uuid     // set for period_close
  note          String?
  takenBy       String?  @map("taken_by") @db.Uuid       // null = the system
  createdAt     DateTime @default(now()) @map("created_at") @db.Timestamptz
  archivedAt    DateTime? @map("archived_at") @db.Timestamptz
  rowCount      Int      @default(0) @map("row_count")
  totalReporting Decimal @default(0) @map("total_reporting") @db.Decimal(18, 2)
  @@unique([workspaceId, kind, periodKey, asOf])
  @@index([workspaceId, periodKey])
  @@map("budget_baseline")
}

/// The baseline's rows: one per live envelope at capture, with what an as-of query cannot
/// reconstruct (structure, granularities, name, dates). Written once; RLS by workspace_id.
model BudgetBaselineRow {
  baselineId      String  @map("baseline_id") @db.Uuid
  workspaceId     String  @map("workspace_id") @db.Uuid
  envelopeId      String  @map("envelope_id") @db.Uuid
  versionId       String? @map("version_id") @db.Uuid    // the approved version at as_of; null = no approved budget yet
  amountReporting Decimal @map("amount_reporting") @db.Decimal(18, 2)
  currency        String  @db.Char(3)
  amount          Decimal @db.Decimal(18, 2)
  parentId        String? @map("parent_id") @db.Uuid
  path            String[]                                 // names root → this, at capture
  name            String
  dimensionValues Json    @map("dimension_values")         // {country: "BR", platform: "meta"}
  startDate       DateTime @map("start_date") @db.Date
  endDate         DateTime @map("end_date") @db.Date
  status          String                                   // the envelope's status at capture
  @@id([baselineId, envelopeId])
  @@index([workspaceId, envelopeId])
  @@map("budget_baseline_row")
}
```

Why rows and not only a timestamp:

- **Structure and granularities are not versioned** (§1). The rows freeze them, so "Q4 plan by country" groups as it was on October 1st, and a budget moved or split since then still shows what it was.
- **Speed and independence from live tables.** A compare on 100k leaves is a join on `(baseline_id, envelope_id)`, not a second version scan per envelope. Archiving, purging demo data or restating a closure never changes a baseline.
- **Storage is small:** one row per live envelope per baseline (100k rows × ~12 baselines a year at spec scale, a few hundred MB), far below `spend_fact`. Rows are written once, in one transaction, so nothing runs against real-time edits.
- The timestamp stays the source of truth: `asOf` is kept on the baseline, and `version_id` on each row points at the very version, so any row is auditable back to who approved what and when.

**Ad-hoc dates need no rows.** "Compare to 14 March" uses the planner's existing `asOf` path with today's structure, and the UI says so ("grouped as today"). A named baseline is the fixed, shareable, structure-true version of the same idea.

### 2.3 When baselines are taken

| Kind | When | By | Name |
|---|---|---|---|
| `period_open` | The first day of every fiscal period in the workspace calendar (month, quarter, year, custom), at 00:00 in the workspace's time zone, taken by a scheduled job (the pacing job already runs every 15 minutes and knows the calendar). | system | "Q4 2026 plan" / "October 2026 plan" |
| `period_close` | Inside `POST /closures`, in the same transaction, `as_of = closed_at`. Restating keeps it (it is what was closed); a re-close takes a new one. | system | "Q3 2026 close" |
| `manual` | "Take a baseline" on Budgets and in Settings › Fiscal calendar, by `closure.close` holders (finance, admins), with a name and a note. | person | free |

The job is idempotent (the unique key), so a missed run is taken late with the *right* `as_of` (the period start), because amounts as of that instant are reconstructable from versions; only structure would be captured late, which the row records with `created_at`. A workspace created mid-period gets its first baseline on its next period start, or by hand.

Decision E1 (owner): also take a `period_open` baseline for the fiscal **year**, not only months and quarters? Proposal: yes (it is the "annual plan").

### 2.4 The planner: compare in one query

Add to `QueryRequest`:

```ts
compareTo?: { baselineId: string } | { asOf: string }   // one of
```

and measures:

| Measure | Definition |
|---|---|
| `budget_baseline` | the baseline's amount for the row (rows joined on `envelope_id`; for `asOf`, the existing as-of CTE) |
| `budget_change_abs` | `budget − budget_baseline` |
| `budget_change_pct` | `budget_change_abs / NULLIF(budget_baseline, 0)` |
| `budget_baseline_in_period` | the baseline's amount prorated to the period, like `budget_in_period` (ADR-047), so pace can be read against the plan too |

Grouped queries and totals sum `budget_baseline` over the same leaves (or subtree, ADR-050) as `budget`, so a roll-up's movement is the sum of its children's, and pivots by any granularity work unchanged. Rows that exist now but not in the baseline (new budgets) have `budget_baseline = 0` and are flagged `isNew`; rows in the baseline that no longer exist (archived, merged) appear only in the movement report (§2.6), not in the tree.

Sorting by `budget_change_abs` gives "biggest movers" for free (the Overview's "Most over pace" pattern).

### 2.5 API

| Route | Permission | Purpose |
|---|---|---|
| `GET /workspaces/:ws/baselines?period=` | `envelope.read` | list, newest first, with counts and totals |
| `POST /workspaces/:ws/baselines { name, periodKey, note?, asOf? }` | `closure.close` | take one now (or at a past instant; structure as of now, said in the response) |
| `PATCH /baselines/:id { name?, note?, archivedAt? }` | `closure.close` | rename, archive |
| `GET /baselines/:id/report` | `envelope.read` | the movement report (§2.6) |
| `POST /workspaces/:ws/query` | existing | `compareTo` + the new measures |
| `GET /envelopes/:id/versions` | existing | each version gains `baselines: [{ id, name }]` where it was the baseline's version, so the drawer's History shows "Q4 plan" and "Q3 close" markers on the right rows |

Each capture writes one `audit_event` (`baseline.taken`) and one outbox row (`baseline.taken`); the search indexer adds baselines as a `setting`-like document so ⌘K finds "Q4 plan".

### 2.6 The movement report

`GET /baselines/:id/report` (and the same behind the UI and MCP): for a baseline and the working budget (or a second baseline, `?against=`):

```json
{
  "baseline": { "id": "…", "name": "Q4 2026 plan", "asOf": "2026-10-01T00:00:00-03:00", "total": "1386014.00" },
  "against":  { "kind": "working" | "baseline", "name": "Now", "total": "1412300.00" },
  "change":   { "abs": "26286.00", "pct": "0.0190" },
  "byKind":   { "increased": { "count": 41, "abs": "…" }, "decreased": { "count": 12, "abs": "…" }, "new": { "count": 3, "abs": "…" }, "removed": { "count": 1, "abs": "…" }, "unchanged": 275 },
  "byDimension": { "country": [ { "code": "BR", "label": "Brazil", "baseline": "…", "now": "…", "abs": "…", "pct": "…" } ], "platform": [ … ] },
  "topMovers": [ { "envelopeId": "…", "name": "…", "path": [...], "baseline": "…", "now": "…", "abs": "…", "pct": "…", "versions": 3, "lastChangedBy": "…", "lastRationale": "…" } ],
  "approvals": { "requests": 18, "byPolicy": { "Standard": 12, "Auto-approve minor": 6 } }
}
```

This is the answer to "how much do budgets vary", computed on request from the baseline rows and live versions, cached by data version like other queries.

### 2.7 UX

**Budgets.** A **Compare** control beside the period picker: "Compare to: — / Q4 2026 plan / September close / a date…". When set:
- the columns become **Plan · Now · Change** (abs and %), Change coloured by sign with the number always shown (plan §11.1 item 8); the totals row too;
- the tree, pivot and timeline all read the same `compareTo` from the URL, so the slice is shareable;
- rows new since the baseline get a "New" chip; a small "3 removed since the plan" link opens them from the report.
- The as-of scrubber on the timeline stays for ad-hoc dates and gains a "Save as baseline" action for finance.

**Budget drawer › History.** Version rows carry markers "Q4 plan" / "Q3 close"; the Details tab shows "Plan USD 682,013 → Now USD 704,001 (+3.2%)" under the approved amount when a compare is set.

**Overview.** One tile, **Since the plan**: `+USD 26,286 (+1.9%) · 41 up · 12 down · 3 new`, opening Budgets with the compare set; the heatmap gets a "Show change since plan" toggle that colours cells by movement instead of pace.

**Closures.** A closure's page shows "Plan → Close" for its period (the two baselines) with the same report, next to the frozen budget-vs-actual it has today.

**Settings › Fiscal calendar.** A **Baselines** list per period: kind, taken at, by whom, rows, total; Take now; Rename; Archive.

**Home.** For a workspace with a closed period: "Q3 closed 4.1% above plan" in the summary strip.

### 2.8 MCP

Three tools, all read-only like the rest (`apps/mcp` imports only `queries/`):

| Tool | Purpose |
|---|---|
| `list_baselines(workspaceId, period?)` | the named moments, so an agent can pick "Q4 plan" |
| `compare_budgets(workspaceId, baselineId | asOf, against?, filter?, groupBy?)` | the movement report of §2.6 for any slice |
| `query_budgets(..., compareTo?)` | the pivot with the new measures, for "top movers by platform" |

Plus `asOf` on `query_budgets`. Questions this answers, in the assistant's words: *"How far is LATAM from the Q4 plan?"*, *"Which platforms moved most between the October 1st plan and the September close?"*, *"Who changed the Brazil Meta budget since the quarter started, and why?"* (the last one through `get_decision_timeline`, which already exists).

### 2.9 What does not change

- Editing, approvals, roll-ups, pacing and alerts: untouched. A baseline is written once by a job or a click, in one transaction, and never read on the edit path.
- Real-time numbers stay live. "Now" is always the working budget.
- Closures keep freezing their full report in the sink; the close baseline is the same instant seen through the planner, not a second system of record.
- Derived numbers stay derived: movement is computed per query, never stored (AGENTS §4).

---

## 3. Alternatives considered

| Option | Why not |
|---|---|
| **Timestamps only, no rows** (pure as-of). | Structure and granularities are not versioned (§1), so "plan by country" would group as today, and moved or split budgets would mislead exactly when finance looks closest. Also a version scan per envelope per compare at scale. Kept for ad-hoc dates. |
| **Snapshot the whole tree to BigQuery per baseline** (like closures). | Right for the archival close report, wrong for a compare column in the live grid: the grid needs a Postgres join. Baseline rows can additionally be exported to the closure dataset for warehouse analysis (task E-010, optional). |
| **Version the structure** (`envelope_dimension` and `parent_id` as versions). | The correct long-term answer to point-in-time structure, but a large change touching the planner's every path, the roll-up cache and the search index. Baseline rows give the product owner the answer now; structure versioning can replace how rows are captured later without changing the API. |
| **Scenarios (`AmountType.SCENARIO`)** as "the plan". | A scenario is a *parallel* tree that people edit; a plan is a *frozen* one. Different thing, and Phase 2 (plan §9.2). |

---

## 4. Tasks (one PR each; H = history)

| ID | Task | Files (main) | Done when | Days |
|---|---|---|---|---|
| H-001 | ADR-053 (this design); domain schemas (`Baseline`, `BaselineRow`, `CreateBaselineInput`, `compareTo` on `QueryRequest`, the four measures); migration with RLS on both tables | `docs/adr/0053-*.md`, `packages/domain/src/baselines.ts`, `query.ts`, migration | round-trip samples; RLS guard test lists both tables | 1 |
| H-002 | Capture command: `POST /baselines` (rows from the as-of versions + current structure, in one transaction, audit + outbox); `GET`, `PATCH`; `versions` gain `baselines[]` | `apps/api/src/modules/baselines/`, `envelopes/queries/versions.ts` | API test: a baseline taken, edited after, still returns the earlier amount and the earlier parent; permission-matrix rows | 2 |
| H-003 | Automatic baselines: `period_open` from the scheduled job (workspace calendar, idempotent), `period_close` inside the close transaction | `apps/workers/src/pacing` (or a new `baselines` job), `closures/commands/close.ts` | Worker test: a period start yields exactly one baseline with `as_of` = period start; closing yields `period_close` with `closure_id` | 2 |
| H-004 | Planner: `compareTo` (baseline join / as-of CTE) and the measures, in flat, grouped, subtree and totals queries; BigQuery dialect gets the same (baseline rows exported per query or via H-010) | `packages/query-planner/src/compile-query.ts`, `measures` | Planner property test: `Σ children change = parent change`; pivot totals equal tree totals with a compare set; bench within 10% | 3 |
| H-005 | Movement report `GET /baselines/:id/report` | `modules/baselines/queries/report.ts` | Golden test: the report's `change.abs` equals the query totals' difference; kinds add up | 1.5 |
| H-006 | Web: Compare control and Plan · Now · Change columns on Budgets (tree, pivot, timeline), URL `compareTo`, New chip, removed link; "Save as baseline" on the scrubber | `routes/w.$ws.budgets.tsx`, `features/explorer/*` | Playwright: pick "Q4 plan", columns appear, reload keeps them, totals match the report | 2.5 |
| H-007 | Web: drawer History markers and Plan → Now line; Overview "Since the plan" tile and heatmap toggle; Closures Plan → Close; Home strip line; Settings › Fiscal calendar › Baselines (take, rename, archive) | drawer, overview, closures, periods routes | Playwright per screen | 2.5 |
| H-008 | MCP: `list_baselines`, `compare_budgets`, `query_budgets.compareTo` and `asOf`; import-guard unchanged | `apps/mcp/src/server.ts`, `queries.ts` | `tools.test.ts`: golden numbers; read-only guard green | 1 |
| H-009 | Golden seed: two baselines (Q3 plan, Q3 close) with assertions; the closure e2e checks Plan → Close; the search index lists baselines | `packages/db/seed/golden.ts`, `golden.assertions.ts` | `pnpm db:seed` < 60 s; assertions green | 1 |
| H-010 | Optional: export baseline rows to the closure dataset (`closures.baselines_<workspace>`) through the `ClosureSink` for warehouse analysis | `closures/sink.ts` | Sink test with the recording sink | 1 |

Order: H-001 → H-002 → H-004 → H-005 → H-003 → H-006 → H-007 → H-008 → H-009 (→ H-010). About 17 engineer-days; H-004 is the one that needs care (the bench and ADR-042's BigQuery routing).

---

## 5. Decisions for the product owner

| # | Decision | Proposal |
|---|---|---|
| E1 | Which periods get an automatic plan baseline. | Every period in the workspace calendar: months, quarters, the year and custom periods. Cheap, and the year is "the annual plan". |
| E2 | The plan's instant. | 00:00 on the period's first day in the workspace's time zone (a new workspace setting, default UTC). |
| E3 | Who may take and archive manual baselines. | The `closure.close` holders (finance, workspace admins). Baselines are never deleted. |
| E4 | Default compare on Overview and Home. | The current period's plan; the previous period's close where the period is closed. |
| E5 | Whether "Change" colours mean good or bad. | Neutral: blue for up, grey for down, the number always shown. Budgets moving is not an error. |
| E6 | Retention. | Keep every baseline; archive hides it from pickers only. |
| E7 | Export baseline rows to the warehouse (H-010). | Yes, once BigQuery credentials exist (plan §16 question 4). |

---

## Appendix — why a timestamp is enough for amounts

An `envelope_version` is created as `DRAFT`, becomes `APPROVED` at `approved_at`, and becomes `SUPERSEDED` (with `superseded_at`) when a later version is approved. The version in force at instant T is therefore the one with the greatest `approved_at ≤ T` among `APPROVED` and `SUPERSEDED` rows, which is exactly what the planner's as-of clause selects. Because rows are never updated in place and approvals are the only transition into `APPROVED`, this reconstruction is exact for any T after the workspace was created, including after restatements (a restatement changes envelope status, not versions). Baseline rows record `version_id`, so every baseline amount can be traced to that row and to its approval decision.
