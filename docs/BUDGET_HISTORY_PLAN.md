# Budget OS — Phase E: snapshots, ending budgets, and "how much did it move?"

Date: 2026-09-28. Follows `docs/UX_AUDIT_AND_ADMIN_PLAN.md` (Phases A–D, merged). Status: building.

**Revision 2 (product owner, 2026-09-28):**
- snapshots are saved **by hand**, not automatically at period start or close;
- a snapshot covers the whole workspace, a filter's budgets, or **one budget and everything under it**;
- people can **end a budget** and **reintroduce** it as a new, linked budget.

## 0. The question, and the short answer

The product owner wants, for any budget and period:

1. **The plan**: what the budget was at a moment that mattered (e.g. what was agreed on October 1st).
2. **The working budget**: what it is now, edited and re-approved all the time.
3. **The closed budget**: what it ended up being when the month or quarter closed.

Then: "how much do budgets move between plan and close, and where?", in the app and through the MCP server. And, alongside: stop a budget before its planned end and start it again later, without losing what happened.

**The short answer: the amounts' history is already kept. What is missing is a way to save a named moment, to compare against it, to end and continue a budget, and the questions.**

- Every approved amount is an immutable `envelope_version` row with `approved_at` and `superseded_at`. Nothing is updated in place (AGENTS §4).
- The planner already answers "budget as of an instant" (`QueryRequest.asOf`). The Budgets timeline has an as-of scrubber.
- A closure locks the period and freezes its report and registry versions (ADR-018).

Real-time editing does not change. A snapshot is written once, by a click, in one transaction, and never read on the edit path.

## 1. What exists, precisely

| Capability | Where | Notes |
|---|---|---|
| Immutable approved amounts with time | `envelope_version(status, approved_at, superseded_at)` | Index `(envelope_id, status, approved_at)`. Drafts never count. |
| "Budget as of T" | `packages/query-planner/src/compile-query.ts` (`asOf`) | Latest version approved by T. |
| As-of in the product | Budgets URL `asOf`, the timeline scrubber, MCP `get_envelope(asOf)` | MCP `query_budgets` has no `asOf` yet. |
| Per-budget history | Drawer › History, `GET /envelopes/:id/versions`, MCP `get_decision_timeline` | |
| Period close | `period_closure`, `closure_envelope`, the `ClosureSink`, `variance_summary` | |
| Split / merge with lineage | `envelope_lineage(kind move / split / merge)`, routed through the approval policy | The pattern ending reuses. |

**Not versioned:** an envelope's granularities, its parent, its name and its dates. An as-of query gives the right *amounts* at T but groups and names them **as today**. That is why a snapshot also freezes rows.

## 2. Design

### 2.1 Vocabulary

| Term | Meaning |
|---|---|
| **Snapshot** (code: `baseline`) | A named, saved copy of budgets at a moment: "Q4 plan as agreed 1 Oct", "Brazil before the re-plan". Taken by hand, for the workspace, a filter, or one budget's subtree. Never edited; archived, not deleted. |
| **Kind** | `plan`, `close` or `other`, chosen when saving. The latest `plan` snapshot is the default "compare to". |
| **Working budget** | The live approved amounts. |
| **Change** | `working − snapshot` (absolute and %), computed per query like CPA, never stored. |
| **Ended budget** | A budget stopped on a date with its final amount (§2.8). Read-only; keeps its history and its spend up to that date. |
| **Successor** | The budget that continues an ended one: same parent and granularities, new dates and amount, lineage `continues`. |

### 2.2 Data model

```prisma
model BudgetBaseline {
  id              String    @id @db.Uuid
  workspaceId     String    @map("workspace_id") @db.Uuid
  name            String
  kind            String                                    // plan | close | other
  scope           Json      @default("{}")                  // {} | { envelopeId } (subtree) | { filter } (FilterGroup)
  periodKey       String?   @map("period_key")              // optional label, e.g. 2026-Q4
  asOf            DateTime  @map("as_of") @db.Timestamptz   // amounts = versions approved by then
  note            String?
  takenBy         String    @map("taken_by") @db.Uuid
  createdAt       DateTime  @default(now()) @map("created_at") @db.Timestamptz
  archivedAt      DateTime? @map("archived_at") @db.Timestamptz
  rowCount        Int       @map("row_count")
  totalReporting  Decimal   @map("total_reporting") @db.Decimal(18, 2)
  @@map("budget_baseline")
}

model BudgetBaselineRow {       // one per live budget in scope at capture; written once
  baselineId      String   @map("baseline_id") @db.Uuid
  workspaceId     String   @map("workspace_id") @db.Uuid
  envelopeId      String   @map("envelope_id") @db.Uuid
  versionId       String?  @map("version_id") @db.Uuid    // the approved version at as_of; null = none yet
  amount          Decimal  @db.Decimal(18, 2)             // envelope currency
  amountReporting Decimal  @map("amount_reporting") @db.Decimal(18, 2)
  currency        String   @db.Char(3)
  parentId        String?  @map("parent_id") @db.Uuid
  name            String
  dimensionValues Json     @map("dimension_values")
  startDate       DateTime @map("start_date") @db.Date
  endDate         DateTime @map("end_date") @db.Date
  isLeaf          Boolean  @map("is_leaf")
  @@id([baselineId, envelopeId])
  @@map("budget_baseline_row")
}
```

Plus `envelope.ended_at`, `ended_by`, `ended_reason` (§2.8). Both new tables are tenant tables with RLS on `workspace_id`.

Why rows and not only a timestamp: structure is not versioned (§1); a compare becomes one join on `(baseline_id, envelope_id)` instead of a version scan; and restating, archiving or purging demo data never changes a snapshot. `version_id` keeps each amount traceable to its approval.

### 2.3 Saving a snapshot (by hand only)

| Where | What it saves | Who |
|---|---|---|
| Budgets toolbar › **Save snapshot** | every live budget, or the current filter's budgets | `closure.close` (finance, admins) |
| Budget drawer › **Save a snapshot of this budget** | the budget and everything under it | `envelope.edit_draft` in its scope |
| Closures › a period › **Save as close** | every budget overlapping the period, kind `close` | `closure.close` |

Name, kind and an optional note; taken **now**. Nothing is captured automatically.

### 2.4 The planner: compare in one query

`QueryRequest.compareTo?: { baselineId } | { asOf }` and measures:

| Measure | Definition |
|---|---|
| `budget_baseline` | the snapshot's amount for the row (or the as-of amount) |
| `budget_change_abs` | `budget − budget_baseline` |
| `budget_change_pct` | `budget_change_abs / budget_baseline` |

Grouped queries and totals sum `budget_baseline` over the same leaves or subtree as `budget`, so a roll-up's change is the sum of its children's. Rows new since the snapshot have `budget_baseline = 0`.

### 2.5 API

| Route | Permission | Purpose |
|---|---|---|
| `GET /workspaces/:ws/baselines` | `envelope.read` | list |
| `POST /workspaces/:ws/baselines` | `closure.close`, or `envelope.edit_draft` in scope for one budget's subtree | save a snapshot |
| `PATCH /baselines/:id` | same as saving | rename, note, archive |
| `GET /baselines/:id/report?against=` | `envelope.read` | the change report (§2.6) |
| `POST /envelopes/:id/end` | `envelope.move` | end a budget (§2.8) |
| `POST /envelopes/:id/reintroduce` | `envelope.create` | a successor (§2.8) |

Every write emits one `audit_event` and one `outbox` row.

### 2.6 The change report

```json
{
  "baseline": { "id": "…", "name": "Q4 plan", "asOf": "…", "total": "1386014.00" },
  "against":  { "kind": "working" | "baseline", "name": "Now", "total": "1412300.00" },
  "change":   { "abs": "26286.00", "pct": "0.0190" },
  "counts":   { "increased": 41, "decreased": 12, "new": 3, "removed": 1, "ended": 2, "unchanged": 275 },
  "byDimension": { "country": [ { "code": "BR", "label": "Brazil", "baseline": "…", "now": "…", "abs": "…", "pct": "…" } ] },
  "topMovers": [ { "envelopeId": "…", "name": "…", "baseline": "…", "now": "…", "abs": "…", "pct": "…", "status": "changed" | "new" | "removed" | "ended" } ]
}
```

### 2.7 UX

- **Budgets:** "Compare to" beside the period (a snapshot, or none). Columns become Plan · Now · Change; totals too; URL `compareTo`. "Save snapshot" in the toolbar.
- **Drawer:** Details shows "In Q4 plan: USD 682,013 → now USD 704,001 (+3.2%)" when a compare is set; History marks versions saved in snapshots; "Save a snapshot of this budget", "End this budget", "Reintroduce".
- **Overview:** "Since the plan" tile when a plan snapshot exists.
- **Closures:** "Save as close" per period and "Plan → Close" when both exist.
- **Settings › Fiscal calendar › Snapshots:** list, rename, archive.

### 2.8 Ending a budget and reintroducing it

**End** (`POST /envelopes/:id/end { endDate, finalAmount, rationale, basedOnVersionId, successor? }`):
- The budget stops on `endDate`: spend after it no longer matches it, and its amount becomes `finalAmount`. The dialog proposes the spend to that date, so the unspent part goes back to the parent; a person can type another amount.
- It is a budget change, so it goes through the approval policy exactly like split: a new version, a bulk change, one request; admins apply directly (ADR-048). On approval the end date and `ended_at` apply. Until then the budget reads "Waiting for approval".
- An ended budget is read-only ("This budget ended on 15 Nov; reintroduce it to keep planning"), keeps its versions, threads and spend, and counts in every period it overlaps with its final amount. Status stays APPROVED, so the planner, roll-ups and pacing are unchanged.
- A budget with live children cannot be ended alone; its children end first.

**Reintroduce** (`POST /envelopes/:id/reintroduce { name?, startDate, endDate, amount, rationale }`, or `successor` inside End):
- A new budget under the same parent, with the same granularities, currency and owner, new dates and amount, lineage `continues` from the ended one. Name defaults to the old one.
- Routed through the approval policy like a new budget (inside End's request when given together).
- The drawer's History shows "Continues …" and "Continued by …".

### 2.9 MCP

`list_baselines`, `compare_budgets(baselineId, against?)`, `query_budgets(..., compareTo?, asOf?)` — read-only like the rest.

### 2.10 What does not change

Editing, approvals, roll-ups, pacing and alerts. "Now" is always live. Change is derived, never stored.

## 3. Alternatives considered

| Option | Why not |
|---|---|
| Timestamps only | Structure is not versioned: a compare would group October's amounts by today's structure. Kept for ad-hoc dates on the timeline. |
| Automatic snapshots at period start and close | Dropped by the product owner: the team decides which moment is "the plan". |
| Snapshots to BigQuery only | The live grid needs a Postgres join. Export can follow once warehouse credentials exist. |
| A new envelope status ENDED | Every status check in the planner, roll-ups, search and UI would change; `ended_at` keeps them untouched. |

## 4. Tasks (five phases, one PR each)

| Phase | ID | Task | Done when |
|---|---|---|---|
| E1 | H-001 | ADR-053; domain schemas; migration (`budget_baseline`, `budget_baseline_row` with RLS, `envelope.ended_*`) | round-trip samples; RLS guard lists both tables |
| E1 | H-002 | Save (workspace, filter, subtree), list, rename, archive; versions list their snapshots | API test: snapshot, then edit and move a budget: the snapshot keeps the old amount and parent; permission rows |
| E1 | H-005 | Change report | test: change = totals difference; counts add up |
| E2 | H-011 | End a budget through the policy; read-only after; children rule | API test: auto-approved for an admin, pending for a planner, final amount and end date applied on approval; edits refused |
| E2 | H-012 | Reintroduce (standalone and with End); lineage `continues`; drawer dialogs and History links | API + Playwright |
| E3 | H-004 | Planner `compareTo` and the three measures | Σ children change = parent change; pivot = tree; planner bench |
| E4 | H-006 | Budgets: Compare to, columns, Save snapshot | Playwright |
| E4 | H-007 | Drawer, Overview, Closures, Settings › Snapshots | Playwright |
| E5 | H-008 | MCP tools | tools test; read-only guard |
| E5 | H-009 | Golden seed: a plan snapshot, an ended budget with its successor | seed < 60 s; assertions |

Deferred: warehouse export of snapshot rows (needs BigQuery credentials).

## 5. Decisions for the product owner

| # | Decision | Proposal (built) |
|---|---|---|
| E1 | ~~Automatic snapshots~~ | Decided: by hand only. |
| E2 | What ending does to the unspent amount | Released to the parent (final amount = spend to the end date), editable in the dialog. |
| E3 | Who saves and archives workspace snapshots | `closure.close` holders; anyone who edits a budget may snapshot its subtree. Never deleted. |
| E4 | Default compare on Overview | The latest `plan` snapshot. |
| E5 | Change colours | Neutral: the number always shown, blue up, grey down. |
| E6 | Ending a parent | Its children end first (a whole-subtree end can follow). |

## Appendix — why a timestamp is enough for amounts

A version becomes `APPROVED` at `approved_at` and `SUPERSEDED` when a later one is approved; rows are never updated in place. The version in force at T is the one with the greatest `approved_at ≤ T` among approved and superseded rows, which is what the planner's as-of clause selects. Snapshot rows record `version_id`, so every saved amount traces to its approval.
