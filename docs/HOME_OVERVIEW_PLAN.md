# BudgetOS — Home and Overview: a rethink

Date: 2026-09-29. Reviewed build: `main` at `c1efe02` (PR #102), running as `pnpm dev:local` from the `BudgetOS-real` worktree (web :5173, API :3000). Workspaces: **Golden** (333 budgets, monthly actuals through August 2026) and the blank **OpenAI** workspace. Personas from `apps/web/e2e/.auth-local/tokens.json`: `orgAdmin`, `admin`, `budgetOwner`, `approver`, `planner`, `finance1`. Viewports 1440×900 and 375×812.

Author: UX/UI review requested by the product owner ("rethink our home and overview tabs"). Status: **built** (HO-001…HO-017, PRs #107, #108, #114 and the G4 PR, 2026-09-29; decisions G1–G10 as proposed). Tasks in §5 follow `AGENTS.md` (one PR each, "done when" as a test). Decisions only the owner can take are in §6.

---

## 0. Summary

Home and the Overview are the first two entries in the navigation, and today they answer the same question with the same four numbers. The plan gives them different jobs (plan §11.4, §11.7, §11.1 item 7): Home is *what needs me*, the Overview is *the state of the money at a glance*. What the build does today:

- **Home shows every role the same page.** Six personas received the same "Waiting on you" (the eight unmatched spend rows), the same two budget strips (EMEA, LATAM) and the same totals. Nobody's Home held an approval, a mention or an alert, while the workspace has 191 open alerts.
- **The Overview is uniform and magnitude-blind.** All 32 heatmap cells sit in one colour band. "Most over pace" lists five budgets at pace 1.04–1.06 worth USD 4–7k each. "Most under pace" leads with two budgets that have no spend at all. The alerts panel lists five names out of 191.
- **The data date silently biases every pace number on both screens.** Actuals are monthly and run through August; "time gone" is counted to today (75% instead of 67%). The whole workspace therefore reads further under pace than it is. Freshness is a grey line at the bottom of the Overview with a green check, and Home does not show it at all.

The direction: one contract per screen (§3.0), one component and one server field for anything that appears on both, and ranking by money rather than by ratio. Home becomes the **desk**: work that is mine and actionable, my budgets with a readable pace, where I left off. The Overview becomes the **room**: the money, where it is ahead or behind in currency, what needs attention, how fresh the numbers are. Four phases, about 29 engineer-days, listed in §5.

---

## 1. What exists (facts from the code and the running stack)

### 1.1 Home (`/w/:ws/home`)

- `apps/web/src/routes/w.$ws.home.tsx` (321 lines) over `GET /me/home` (`apps/api/src/modules/home/home.ts`, schema `HomeResponse` in `packages/domain/src/home.ts`). ADR-035 (Home first in the nav), ADR-051 (headline = top-level budgets).
- Order on screen: greeting and date line; tour invite; demo banner; four tiles (Budget this fiscal year, Spent, Open alerts, Waiting on you); **Waiting on you** (approvals I can decide, mentions of me in open threads, alerts with `owner_id = me`, the unmatched count); **Your budgets this fiscal year** (top-level budgets I own or my roles can read, at most eight); **Recent** (the last eight entities I touched, from the audit log); **Saved views**.
- A blank workspace shows "Add your first budgets" and a five-step list. This works and this plan leaves it alone.

### 1.2 Overview (`/w/:ws`)

- `apps/web/src/routes/w.$ws.index.tsx` (555 lines) and `features/overview/cell-editor.tsx`, over `GET /workspaces/:ws/overview?period&rows&cols` (`apps/api/src/modules/overview/overview.ts`). ADR-029 (one call, pace not projection), ADR-045 (layout per person, edit from a cell), ADR-047 (pace against the period share), ADR-051.
- One request, 346 ms on the golden today; every number from the planner over live leaves; the headline from the top-level budgets.
- Order on screen: seven tiles (Budget, Spend to date, Spent %, Projected close, Open alerts, Waiting for me, Since the plan); the heatmap (any two granularities, in the URL; top 12 × 8 then "Show all"; a cell shows % spent, coloured by pace band; clicking opens the cell editor); Most over pace and Most under pace (five leaves each, by pace index); CPA vs target by the row granularity; Open alerts (counts by severity and the five newest); Approvals waiting for me (five soonest); Data freshness. **Customise** hides sections per person as a private `overview` saved view; a workspace-shared view is everyone's default, but there is no UI to create one.

### 1.3 Numbers observed today (Golden, period "This fiscal year")

| Fact | Value |
|---|---|
| Headline budget / assigned to leaves | USD 1,386,014 / USD 1,114,679 |
| Spent | USD 653,984 = 47% of the headline, 59% of the leaves |
| Fiscal year gone (today, 29 Sep) | 75% |
| Last actual | the August rows (monthly, dated 2026-08-01), covering through 31 August = 67% of the year |
| Pace index, headline / leaves | 0.63 / 0.79 |
| Open alerts | 191 on the Overview, 193 on Home |
| Alerts by rule | CPA over target 100 (warning) · CPA far over target 83 (critical) · Over-pace 8, on 106 of 193 leaves |
| Alerts assigned to a person | 0 |
| Approvals waiting for any of the six personas | 0 |
| Heatmap | 8 countries × 4 platforms; all 32 cells in the 0.80–0.95 band |
| Most over pace | pace 1.044–1.056, budgets USD 4.5k–6.9k |
| Most under pace | two AR › amazon budgets with zero spend, then 0.71–0.72 |
| Home per persona | `waitingOnMe`, `scopes` and `totals` identical for all six |

---

## 2. Findings

P0 = misleading, or defeats the screen's purpose. P1 = the screen does not do its job well. P2 = polish.

### 2.1 Both screens

| # | Finding | Evidence | Direction |
|---|---|---|---|
| B-1 · P0 | **The data date biases every pace number, silently.** `elapsed` and the planner's pace divide by time gone *to today*. The golden actuals are monthly: the rows dated 2026-08-01 hold all of August. Through 31 August 67% of the year had gone and the leaves had spent 59% of their budgets, a pace of about 0.88; counted to today the Overview reads 0.79 and Home 0.63. The only sign is "Actuals through 2026-08-01" in 12 px grey at the bottom of the Overview, next to a green check, and it names the first day of the month rather than the last. Home has no freshness at all (plan §11.4 lists it). | `overview.ts` (`elapsedFraction(range, today)`), `home.ts` (same), `compileQuery(rq, period, today, …)`; API probe in §1.3 | An as-of chip in both headers; a warning banner past N days; compute time gone and pace as of the last day with actuals (Decision G2, an ADR amending ADR-047's inputs). A monthly fact covers its whole month. |
| B-2 · P0 | **The same number, two definitions.** Open alerts: Home 193 (OPEN + ACKNOWLEDGED), Overview 191 (OPEN). Home's "Waiting on you: 1" counts the unmatched line as one item. The audit's P0-6 was fixed for the budget (ADR-051); the counts were not covered. | `home.ts` (`alert.count … in ["OPEN","ACKNOWLEDGED"]`), `overview.ts` (`status === "OPEN"`) | One `OPEN_ALERT_STATUSES` in `@budget/domain`; one `HeadlineStrip` component fed by the same server fields. |
| B-3 · P1 | **The screens duplicate each other.** Four of Home's tiles are four of the Overview's seven. The Overview hosts a personal panel (Approvals waiting for me); Home hosts workspace totals. A new user cannot tell why both exist. | screenshots | The contract in §3.0: personal on Home, workspace on the Overview, one line of shared "pulse" on Home. |
| B-4 · P1 | **Three visual grammars for pace.** Home strips: bar length = % spent, bar *colour* = pace, no time tick, no legend. Overview: five pale bands with a legend. Budgets grid: bar + tick + number. Plan §11.1 item 1 asks for one glanceable pacing bar. | screenshots | One `PaceBar` component and one `PACE_BANDS` constant shared by domain, grid, Home and Overview. |
| B-5 · P2 | Official registry labels break layouts: "United Kingdom of Great Britain and Northern Ireland" wraps the KPI table and the heatmap row header. | `packages/db/seed/iso-countries.ts:243` | Short labels; keep the official name as an alias for search. |

### 2.2 Home

| # | Finding | Evidence | Direction |
|---|---|---|---|
| H-1 · P0 | **Home is not personal.** Alerts show only when `owner_id = me` (none of the 191 are assigned). Mentions are rare. Approvals appear only when a policy routes to me. Everyone therefore gets the same page: the eight unmatched rows and two strips. The plan's "to-do list, not a feed" (§11.7) is an empty list in a busy workspace. | `GET /me/home` for six personas: identical | Widen "mine" with ownership and scope; add my unsent drafts and my requests waiting on others; §3.1. |
| H-2 · P1 | **"Data to map" is shown to people who cannot map it.** Planner, approver and finance all see "8 spend rows match no budget yet". | screenshots per persona | Show it only to callers who can act on the unmatched queue. |
| H-3 · P1 | **Recent is noise.** Planner: eight rows all titled "CPA target". Admin: eight sibling budgets "DE amazon …". Bulk request titles are cut off. No verb (what did I do?), no parent, no time. | screenshots | Deduplicate; title = what · where; the verb from the audit event; relative time; five items. |
| H-4 · P1 | **The strips cannot be read for pace.** EMEA and LATAM both show 47% with no tick for 75% of the year gone, no alert or pending chips, no projected. Plan §11.7 asks for target · approved · actual · projected with pace; plan §11.1 item 4 asks for status at every level. The link opens Budgets by the budget's dimension values, not by the budget itself. | `w.$ws.home.tsx` scopes block; `home.ts` `filter` | `PaceBar` with tick and band; chips for waiting approvals and open alerts; projected when present; link by `envelopeId` into the budget structure. |
| H-5 · P2 | The four tiles push the desk down: at 1440×900 "Waiting on you" starts a third of the way down and "Your budgets" is at the fold. The tiles' only unique value is the greeting line's numbers. | screenshot | A one-line pulse (Decision G1). |
| H-6 · P2 | Saved views is a card of its own for a lone view ("Dmoe"). | screenshot | Chips under Recent. |

### 2.3 Overview

| # | Finding | Evidence | Direction |
|---|---|---|---|
| O-1 · P0 | **The ranking is magnitude-blind.** Sorting leaves by pace index surfaces USD 5k budgets barely over 1.05 as "most over pace", and ended or zero-spend budgets as "most under pace". Money at stake plays no part; a USD 100k budget at 1.04 never appears. | API probe: `variances` | Rank by currency ahead or behind plan (`actual − budget_in_period × elapsed`, a derived planner measure), with categories: Over pace, Under pace, No spend yet, KPI off target. Decision G6. |
| O-2 · P0 | **191 alerts, five names.** 183 of 191 come from the two default CPA rules and cover 106 of 193 leaves. The panel lists the five newest by budget name, which cannot be acted on, and hides the real message: one rule is firing on half the workspace. Grouping was left out of DS-004 because it must be server-side. | API probe: alerts by rule | Aggregate server-side by rule and by the row granularity; a "rule health" hint; links into Alerts filtered by rule. Decision G3 on the thresholds. |
| O-3 · P1 | **The heatmap is uniform and overloaded.** All 32 cells in one band; the band tints are 10–30% alpha on white; the number is % spent while the colour is pace, explained in an 11 px hint. No row or column totals, so a country or a platform cannot be read at once. A click both inspects and edits. | screenshot; `BANDS` in `w.$ws.index.tsx` | Marginal totals from the planner; stronger, distinguishable tints checked by the contrast test; a hover/focus popover with the numbers and two explicit actions; alert dots per cell. |
| O-4 · P1 | **Seven tiles, no hierarchy; two are placeholders.** Projected close is "—" (the golden has no projections; production loads them from the warehouse) and Since the plan is "—" with a sentence of instructions. Spent % repeats Spend to date's hint. Counts (alerts, approvals) sit between money tiles. | screenshot | Four headline tiles about money; tiles with no data are not rendered and Data says why; Since the plan becomes a delta line under Budget when a snapshot exists; counts move to the attention rail. |
| O-5 · P1 | **Personal content on a workspace page.** "Approvals waiting for me" is 0 for every persona. What a lead wants here is the workspace queue: how many wait, how many are overdue, how old the oldest is, who holds them. | API probe: `approvals.mine = 0` ×6 | Queue statistics server-side; personal items on Home. |
| O-6 · P1 | **Period is the only control.** No as-of, no compare with a snapshot (Budgets has `compareTo`). Customise hides sections but cannot reorder them, cannot remember the axes (URL only), and cannot set a team default although the API accepts a workspace-visibility view (ADR-045). | `w.$ws.index.tsx` header, `useLayout` | Header: Period · As of · Compare to · Customise (reorder, remember axes and sort, workspace default). |
| O-7 · P2 | **On a phone** the heatmap is a horizontally scrolled table and the tiles stack with their dashes. Decision D7 (round 6) chose read-and-approve on phones. | 375 px screenshot | Ranked lists on phones; the heatmap is desktop-only and says so. |
| O-8 · P2 | Legend and hints are 11–12 px at the bottom; "click a cell to edit its budgets" sits in the header line where nobody reads it. | screenshot | Legend as chips beside the title; the hint moves into the cell popover. |

---

## 3. Design direction

### 3.0 The contract

| | **Home** | **Overview** |
|---|---|---|
| Question | What needs me today, and how are my budgets doing? | How is the workspace's money doing, and where is the risk? |
| Subject | the signed-in person | the workspace, cut to the caller's read scope |
| Period | the fiscal year, fixed | any period (picker) |
| As of | the last day with actuals, always shown | the same |
| Content varies with | who I am: roles, ownership, scope | what I pick: period, axes, layout |
| Actions | decide, send, map, open | inspect, drill into Budgets, edit a cell, share a layout |
| Empty state | "Nothing is waiting on you" + my budgets (exists) | "No budget has both X and Y yet" (exists) |

Rules that keep them apart:

1. A number that appears on both screens comes from the same server field through the same component.
2. Personal items live on Home only. Workspace queues live on the Overview only.
3. Both show the as-of date in the header and warn when actuals are stale.
4. Nothing is summed, sorted or ranked in the browser (`AGENTS.md` §4, §9). Every list has a server-side order and a "See all" that opens its screen with the same filter.
5. Every colour has a legend, every derived number has a tooltip with its formula and its as-of (plan §11.1 item 8).

### 3.1 Home: the desk

```
┌─ Good morning, Gonzalo ───────────────────────────────────────────────────────────────────┐
│ Golden · Tuesday 29 September · FY2026, day 272 of 365 (75%) · [Actuals through 31 Aug]          │
│ [ Tour invite, when one is pending ]   [ Demo data banner, when demo rows exist ]              │
│ Golden this year · USD 1.39M budget · 47% spent · 191 alerts · 12 waiting for approval     Overview → │
├─ Waiting on you · 5 ─────────────────────────────────────────────────── overdue first ─────┤
│ ✓  Approve   Q4 retail push · 24 budgets · +USD 6,880 (+5%) · Ana · due today            [Decide] │
│ ✎  Send      2 drafts of yours are not sent for approval · MX meta …, DE meta …          [Review] │
│ 🔔 Alerts    3 alerts on your budgets · EMEA: CPA far over target ×2, Over-pace ×1        [Open]   │
│ @  Mention   Priya mentioned you on LATAM · "can we move 10k to …"                        [Reply]  │
│ ⌁  Data      8 spend rows match no budget yet                       (only if I can map)   [Map]    │
│ 🔒 Close     Q3 closes in 5 days · 2 budgets still in draft         (only for finance)    [Closures] │
├─ Your budgets · FY2026 ────────────────────────────────────────────────────────────────────┤
│ EMEA  · Owner      USD 322,976 of 682,013   ▓▓▓▓▓▓▓▓▓░░│░░░░░░  47% spent · pace 0.88 as of 31 Aug │
│                    ⚑ 2 waiting · 🔔 61 alerts · projected — (no projections loaded)            │
│ LATAM              USD 331,008 of 704,001   ▓▓▓▓▓▓▓▓▓░░│░░░░░░  47% spent · pace 0.88 as of 31 Aug │
│                    ⚑ 0 waiting · 🔔 130 alerts                                    [+ New budget] │
├─ Pick up where you left off ───────────────────────┬─ Sent by you · 3 waiting on others ───────┤
│ ✓ Q4 retail push · approval · you requested · 2 h  │ Q4 retail push → Ana · 2 days             │
│ ▤ DE amazon awareness prospecting · EMEA › DE · you changed the amount · yesterday │ …          │
│ ◎ CPA target · MX meta conversion · you set · Mon  │                                            │
│ Your views: [LATAM by country] [Dmoe]              │ All open requests →                        │
└────────────────────────────────────────────────────┴────────────────────────────────────────────┘
```

Numbers in the wireframes are illustrative except where they match §1.3.

**Header.** The greeting stays (round 3). One orientation line: workspace, date, fiscal position, and the `AsOfChip`. The chip is neutral when actuals are current and turns to the warning tone with "N days old" once they are stale (Decision G7: two days for a daily source; a monthly source is stale when last month is still missing ten days after it ended).

**Pulse row.** Replaces the four tiles (Decision G1). One line, the compact variant of `HeadlineStrip`, fed by a `pulse` object on `/me/home` with the same fields the Overview headline uses: budget, spent % against time gone, open alerts, approvals waiting in the workspace. It links to the Overview. The owner asked for a summary strip in round 3; this keeps the numbers and stops them competing with the desk.

**Waiting on you.** The inbox, in this priority. Each item has a kind, a title, one line of context and one primary action.

1. **Approvals I can decide** (exists): summary, number of budgets, delta in money and percent, requester avatar, due chip (danger tone when overdue). **Decide** opens the request in a side sheet on Home built from the approval detail parts (diff table, context cards, decision bar), so an approver never leaves Home; the full page stays one click away (Decision G4).
2. **My unsent drafts** (new): envelope versions in DRAFT created by me with no open request. This is the lost-work case from the Budgets feedback ("findable send for approval"). **Review** opens Budgets with them selected; sending uses the existing card.
3. **Alerts on my budgets** (widened): alerts assigned to me first, then open alerts on budgets I own or inside my role scope, grouped by top-level budget and rule ("EMEA: CPA far over target ×2"). **Open** goes to Alerts filtered by that budget's subtree.
4. **Mentions** (exists).
5. **Data to map** (restricted): only for callers who can act on the unmatched queue (H-2). A failed ingest run belongs here too, for the same callers.
6. **Closure due** (new, finance): the next period ending within 14 days, and how many budgets in it are still draft or pending.
7. Empty: "Nothing is waiting on you" with the check (exists).

Order: overdue → due soonest → newest. At most ten items; "See all" per kind opens its screen filtered.

**Your budgets.** One `PaceBar` per top-level budget I own or my scope reads, owned first with an "Owner" chip. Each row: name; spent of budget in money; the bar (length = % spent, tick = time gone, colour = pace band); pace index with its as-of; chips for waiting approvals and open alerts (status at every level, plan §11.1 item 4); projected close when projection facts exist. The row opens Budgets on that budget in the structure (`select` = the budget), not on its dimension values. "New budget" sits here for people who can create one (the dialog exists).

**Pick up where you left off.** Five deduplicated items: an entity icon, the title with its parent ("CPA target · MX meta conversion"), the verb from the audit event kind ("you approved", "you changed the amount", "you set"), relative time. Saved views become chips under the list.

**Sent by you.** My open requests: summary, whom they wait on, age. Links to Approvals › All open filtered by requester.

**How it reads per role.** Planner: drafts, mentions, their budgets. Approver: approvals, mentions. Budget owner: approvals, alerts on their budgets, their strips first. Finance: closures, approvals of manual results. Data admin: data to map, failed runs. Admin: everything. The Playwright suite proves the six golden personas get six different desks (HO-005).

### 3.2 Overview: the state of the money

```
┌─ Overview ─────────── Period [This fiscal year ▾] · [As of 31 Aug] · Compare to [FY2026 plan ▾] · [Customise ▾] ─┐
│ ⚠ (only when stale) Actuals stop on 31 Aug 2026 (40 days ago). Spent and pace are read as of that day. Spend data → │
├─ Headline ───────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Budget                 │ Spent                    │ Remaining                  │ Projected close  (only when  │
│ USD 1.39M              │ USD 654k · 47%           │ USD 732k                   │ projections are loaded)      │
│ ▓▓▓▓▓▓▓▓░░ 80% split   │ ▓▓▓▓▓▓▓░░│░░ time 67%   │ 93 days left · USD 7.9k/day│ 98% · USD 1.36M              │
│ into the budgets below │ as of 31 Aug             │ to spend it all            │ from Snowflake · 26 Sep      │
│ +USD 120k since FY2026 plan →                                                                                 │
├─ Pace by [Country ▾] × [Platform ▾]   legend: [● under 0.80] [● 0.80–0.95] [● on plan] [● 1.05–1.20] [● over 1.20] ┤
│               TikTok        Amazon        Google Ads    Meta        │ Country                                  │
│ Colombia      59%  🔔2      59%           59%  🔔1      61%  🔔5   │ 60%  USD 154k  pace 1.01                  │
│ Germany       60%           56%           59%           63%  🔔3   │ 59%  …                                    │
│ …                                                                   │                                          │
│ Platform      59%           55%           60%           61%        │ 59%  USD 1.11M  pace 1.00                 │
│                                                                                                               │
│  ┌ Colombia × Meta ─────────────────────────────────────────┐   ← popover on hover / focus / Enter            │
│  │ 5 budgets · USD 32,586 budget · USD 19,877 spent (61%)   │                                                 │
│  │ pace 0.91 as of 31 Aug · 5 open alerts · 0 waiting       │                                                 │
│  │ [Open in Budgets]  [Edit these budgets]                  │                                                 │
│  └──────────────────────────────────────────────────────────┘                                                 │
├─ Needs attention · 14 ── [All] [Over pace 6] [Under pace 4] [No spend yet 2] [KPI off target 2] ─────────────┤
│ ↑ MX meta awareness retargeting   LATAM › MX › meta    +USD 1,120 ahead of plan · 79% spent · pace 1.06 · 🔔2 │
│ ↓ GB amazon conversion retargeting EMEA › GB › amazon  −USD 2,300 behind plan · 54% spent · pace 0.72        │
│ ○ AR amazon conversion retargeting · Walmart           no spend yet · USD 6,216 budget · ends 31 Dec         │
│ …                                                              See all in Budgets, sorted by ahead of plan →  │
├─ Alerts · 191 open ────────────────────┬─ CPA vs target by Country ──────────┬─ Approvals queue ─────────────┤
│ CPA over target       100 · MX 33 ES 32│ Colombia  21.87 ▐▌ 20.50   +6.7%    │ 12 waiting · 3 overdue        │
│ CPA far over target    83 · critical   │ Mexico    24.47 ▐▌ 17.00  +44.0%    │ oldest 9 days                 │
│ Over-pace               8              │ …                                   │ Ana 7 · Luis 5                │
│ ⓘ One rule fires on 106 of 193 budgets │ Lower is better                     │ budgets 10 · targets 2        │
│ Open in Alerts, by rule →              │ Targets →                           │ Open the inbox →              │
├─ Data · Actuals through 31 Aug · Golden actuals (CSV) ✓ 26 Sep 12:01, matched 100% · no projections loaded · Spend data → ┤
```

**Header controls.** *Period*: the Budgets period picker, extracted into `<PeriodPicker/>` (spec §18.3 names it) so fiscal quarters and custom periods behave the same on both screens. *As of*: the `AsOfChip`, read-only. *Compare to*: the snapshot picker Budgets already has; when set, Budget shows the delta line and the heatmap can switch its number to "change since plan". *Customise*: see below. For admins, "Set as workspace default".

**Staleness banner.** Shown when the actuals are stale (Decision G7: a daily source more than two days behind; a monthly source whose last month is still missing ten days after it ended): the date, the age, what it affects, a link to Spend data.

**Headline: four tiles about money.** *Budget* with an "assigned below" mini-bar that makes ADR-051's gap visible (USD 1.11M of 1.39M split into budgets; in the OpenAI workspace 30M of 150M). *Spent* in money and percent with a `PaceBar` (tick = time gone as of the data). *Remaining* with calendar days left and the run rate needed to spend it all; this is arithmetic on remaining ÷ days, shown as such, never a forecast. *Projected close* only when projection facts exist (the warehouse's number, with its source and date); otherwise the tile is not rendered and Data says "no projections loaded". "Since the plan" is a line under Budget when a plan snapshot exists. Counts of alerts and approvals leave the headline.

Two clocks are honest here: spent and pace are as of the last actual; remaining and days left are calendar facts as of today. Each tile says which.

**Heatmap v2.** The same endpoint with three additions computed server-side: marginal totals (row totals, column totals, grand total: two more grouped planner queries in the same `Promise.all`), per-cell open-alert and pending-approval counts (an aggregate over `envelope_dimension`), and "change since plan" per cell when `compareTo` is set. The cell keeps % spent as its number (the owner's choice, round 3) and pace as its colour, now from the shared `PACE_BANDS` with tints strong enough to tell apart and text that passes AA on every tint (extend `tokens.contrast.test.ts`). An alert dot with the count sits in the corner. Hover, focus or Enter opens a popover with the full numbers, the pace index with its as-of, the alert and pending counts, and two explicit actions: **Open in Budgets** (the pivot, filtered) and **Edit these budgets** (the existing cell editor). Arrow keys move between cells. Rows sort by budget (default), pace, or ahead of plan. The legend is a row of chips beside the title. On phones the heatmap becomes a ranked list of rows with a `PaceBar`, and a segmented control picks the column value.

**Needs attention.** One list replaces Most over pace, Most under pace and the alerts' five names. The server ranks by money, using a new derived planner measure `ahead_of_plan_abs = actual − budget_in_period × elapsed` (positive = ahead of plan / over pace, negative = behind). Filter chips: Over pace, Under pace, No spend yet (live budget, actual 0), KPI off target (from the KPI query), Data (unmatched, failed runs). Each row: direction, name, path, money ahead or behind, % spent, pace, alert count, pending chip. Ended budgets are excluded (`ended_at`, ADR-053). "See all in Budgets" opens the Explorer sorted by the same measure.

**Alerts by rule.** Counts per rule and severity with the top row-granularity values ("MX 33 · ES 32"), each a link into Alerts filtered by rule and value. A "rule health" hint when one rule fires on more than half of the leaves it covers ("This rule fires on 106 of 193 budgets. Review its threshold in Pacing rules.").

**KPI vs target.** The table stays; each row gains a bullet bar (actual against target, direction-aware), a short label, the number of budgets behind it, and sorting by gap. A row opens Targets or Budgets filtered to that value.

**Approvals queue.** Workspace-level: waiting, overdue, age of the oldest, by approver (the bottleneck), by kind (budgets, targets, manual results). Links to the inbox. The personal list moves to Home.

**Data.** One line at the bottom: last actual, each source with status, time and match coverage, whether projections are loaded, a link to Spend data. When stale, the banner at the top carries the warning; the footer stays neutral.

**Customise v2.** Hide and show (exists), reorder sections (dnd-kit is already a dependency), remember axes and sort in the layout, and "Set as workspace default" for admins, writing the workspace-visibility `overview` view the API accepts today (ADR-045). The layout definition grows from `{ hidden }` to `{ hidden, order, axes, sort }` as an `OverviewLayout` zod schema in `@budget/domain`.

### 3.3 Shared pieces

- **`PACE_BANDS`** in `@budget/domain`: thresholds 0.80 / 0.95 / 1.05 / 1.20, label keys and tone names. Used by the web (Home strips, Overview cells and legend), the grid's pace cell renderer, and documented against the default over-pace rule (1.10 for three days), which stays a separate setting.
- **`OPEN_ALERT_STATUSES`** in `@budget/domain` (OPEN and ACKNOWLEDGED), used by Home, the Overview and the MCP `describe_workspace` counts.
- **`@budget/ui`**: `PaceBar` (length = spent, tick = time gone, band colour, `aria-label` with the numbers, two sizes); `StatTile` (label, value with a small currency code, hint, optional mini bar, link; compact notation such as "USD 1.39M" with the exact value in the tooltip, replacing the shrinking `TileValue`); `AsOfChip`; `HeadlineStrip` (full for the Overview, one line for Home); `SectionHeader` (title, legend chips, actions).
- **Money**: compact in tiles and strips, exact in lists. Tabular figures everywhere (already the rule).
- **Country labels**: short names in the seed and a migration for the built-in rows; the official name becomes an alias so search still matches it.

### 3.4 API and domain changes

All additive. No table changes; the only new shape is the layout definition, which is a saved view's JSON.

`GET /me/home` v2 (`HomeResponse` gains optional fields):

- `asOf: { lastFactDate, staleDays }`
- `pulse`: the Overview headline fields (budget, actual, spentPct, elapsed, openAlerts, waitingApprovals)
- `waitingOnMe.approvals[]` gains `delta`, `count`, `requestedByName` (the inbox already has them)
- `waitingOnMe.drafts[]`: my DRAFT versions with no open request
- `waitingOnMe.alertsOnMyBudgets[]`: grouped by top-level budget and rule, assigned-to-me first
- `waitingOnMe.unmatched` only when the caller may act; `waitingOnMe.canMap`
- `waitingOnMe.closures[]` for callers with `closure.close`
- `waitingOnMe.failedRuns[]` for callers with `source.manage`
- `sent[]`: my open requests, whom they wait on, age
- `recents[]` gains `action` and `parent`, deduplicated, five items
- `scopes[]` gains `owner`, `alerts`, `pending`, `remaining`; `envelopeId` becomes the link target (`filter` stays for the old client)

`GET /workspaces/:ws/overview` v2 (additive; `sort` and `compareTo` query parameters):

- `asOf: { lastFactDate, staleDays, elapsedAsOfData }`
- `headline` gains `remaining`, `daysLeft`, `runRateNeeded`, `sincePlan` (from the snapshot report the tile already reads)
- `heatmap` gains `rowTotals[]`, `colTotals[]`, `total`, and per cell `alerts`, `pending`, and with `compareTo` `budget_baseline` / `budget_change_abs`
- `attention[]` ranked by `|ahead_of_plan_abs|` with `category`; `variances` stays one release for the old client
- `alertsByRule[]`, `alertsByRow[]`, `ruleHealth[]`
- `approvalsQueue: { waiting, overdue, oldestDays, byAssignee[], byKind[] }`; `approvals.mine` stays for Home's pulse

Planner: a derived measure `ahead_of_plan_abs` in both dialects (Postgres and BigQuery), never stored (`AGENTS.md` §4), with an ADR. `@budget/domain`: `OverviewResponse` (today the shape is parsed only in the web route), `HomeResponse` v2, `OverviewLayout`, `PACE_BANDS`, `OPEN_ALERT_STATUSES`. Permissions unchanged (`envelope.read` for the Overview; Home is the caller's own); the restricted Home blocks check permissions server-side. The Overview stays one request and keeps the T-033 budget (< 1.5 s on the golden), asserted in `overview.test.ts`.

### 3.5 What does not change

Two screens, Home first (ADR-035). The blank-workspace flow on Home. The cell editor and the bulk preview path (ADR-045). Layout persistence as a saved view (ADR-045). % spent as the heatmap number (round 3). One request per screen. Server-side aggregation. The tours' targets `home-waiting`, `home-pacing` and `nav-overview` keep their attributes; new sections get their own. Strings through i18n keys. Every number cut to the caller's scope.

---

## 4. Alternatives considered

- **Merge Home and the Overview into one page.** Rejected. Plan §11.4 and ADR-035 keep them apart; approvers on phones need a short page (Decision D7); a merged page would put the desk under a heatmap. The duplication goes away through the contract instead.
- **Rank "Needs attention" in the browser from the heatmap payload.** Rejected: `AGENTS.md` §4 and §9 forbid sorting and roll-ups in the browser, and the payload holds only the top 12 × 8 cells.
- **Store a risk score per budget.** Rejected: derived numbers are computed at query time (`AGENTS.md` §4).
- **Compute a run-rate projection when none is loaded.** Rejected: spend and projected spend come from the warehouse (product owner, 2026-09-27). "USD 7.9k/day to spend it all" is arithmetic on remaining ÷ days and is labelled so.
- **Keep the seven tiles and only reorder them.** Rejected: two of seven are placeholders on the reference dataset and two duplicate each other; the problem is the mix of money and counts, not the order.

---

## 5. Tasks (four phases, one PR each)

Conventions from `AGENTS.md`: branch `task/HO-005-home-v2`, commits `HO-005: …`, status rows in `docs/TASKS_STATUS.md` under "Product feedback, round 9: Home and Overview". Estimates are engineer-days for someone who knows the repo. ADR numbers continue from the latest in `docs/adr/`.

### Phase G1 — one truth for shared numbers (≈ 5 days)

| ID | Task | Files (main) | Done when | Days |
|---|---|---|---|---|
| HO-001 | `PACE_BANDS`, `OPEN_ALERT_STATUSES` and `OverviewResponse` in `@budget/domain`; Home and the Overview count alerts the same way | `packages/domain/src/pacing.ts`, `home.ts`, new `overview.ts`; `modules/home/home.ts`, `modules/overview/overview.ts`; both web routes | `home.test.ts` and `overview.test.ts`: the open-alert count is equal for the same caller; the web parses the Overview with the domain schema | 1 |
| HO-002 | `PaceBar`, `StatTile`, `AsOfChip`, `HeadlineStrip`, `SectionHeader` in `@budget/ui`; compact money with the exact value on hover; the contrast test covers each band's text on its tint | `packages/ui/src/pace-bar.tsx`, `stat-tile.tsx`, `as-of-chip.tsx`, `headline-strip.tsx`, `tokens.contrast.test.ts` | Vitest: band mapping and `aria-label`; contrast test green in light and dark | 1.5 |
| HO-003 | As of and staleness: `asOf` on both endpoints; the chip in both headers; the banner past the threshold; time gone and pace computed as of the last actual (Decision G2) with an ADR | `home.ts`, `overview.ts`, planner `today` argument, ADR | Golden: the header reads "Actuals through 31 Aug 2026" (the August rows are monthly, so they cover the month); with G2, time gone and pace are computed through that day, so the heatmap's total pace reads about 0.88 instead of 0.79 (the test asserts the elapsed used equals the data-through date); a daily source three days behind shows the banner | 1.5 |
| HO-004 | Short country labels; the official name kept as an alias | `packages/db/seed/iso-countries.ts`, a migration updating the built-in `dimension_value` labels and aliases | Search still finds "Great Britain"; the KPI table fits at 1280 px without wrapping | 1 |

### Phase G2 — Home as the desk (≈ 9 days)

| ID | Task | Files (main) | Done when | Days |
|---|---|---|---|---|
| HO-005 | `/me/home` v2: drafts, alerts on my budgets (grouped), sent, closures, failed runs, actionable unmatched, recents with verb and parent, scopes with chips, `pulse` | `modules/home/home.ts`, `packages/domain/src/home.ts`, `openapi.json`, web client | `home.test.ts`: the six golden personas get six different `waitingOnMe`; a planner with an unsent draft sees it; a planner never sees `unmatched > 0`; finance sees the closure line inside 14 days of a period end | 3 |
| HO-006 | Home v2 layout: header with the as-of chip, the pulse row (Decision G1), Waiting on you with kinds and actions, Your budgets with `PaceBar` and chips, Pick up where you left off, Sent by you, views as chips | `routes/w.$ws.home.tsx` → `features/home/desk.tsx`, `waiting.tsx`, `budgets.tsx`, `recents.tsx` | Playwright per persona: block order; each item opens its screen filtered; every action reachable by keyboard; snapshots at 1440 and 375 | 3 |
| HO-007 | Decide from Home: a side sheet with the approval detail parts (diff, context, decision bar) opened from Waiting on you (Decision G4) | `features/approvals/detail.tsx` extracted from `routes/w.$ws.approvals.$id.tsx`; `features/home/decide-sheet.tsx` | Playwright: the budget owner approves the golden bulk from Home; the item leaves the list; the existing command emits audit + outbox (asserted) | 2 |
| HO-008 | Tours, strings and status: `home-waiting` / `home-pacing` kept, new steps for the desk; i18n keys; `TASKS_STATUS` rows | `packages/db/seed/defaults.tours.ts`, `packages/ui/src/i18n.ts`, `docs/TASKS_STATUS.md` | `home-tours.spec.ts` green for the four roles | 1 |

### Phase G3 — Overview as the state of the money (≈ 12 days)

| ID | Task | Files (main) | Done when | Days |
|---|---|---|---|---|
| HO-009 | Planner measure `ahead_of_plan_abs` in both dialects, with an ADR | `packages/query-planner/src/compile-query.ts`, `compile-aggregate.bq.ts`, `packages/domain/src/filter-ast.ts` | Planner tests: a leaf and a group equal `actual − budget_in_period × elapsed`; `pnpm bench` unchanged | 1.5 |
| HO-010 | `/overview` v2: margins, per-cell alerts and pending, attention list with categories, alerts by rule and by row, rule health, approvals queue, headline remaining / run rate / since plan, `sort`, `compareTo` | `modules/overview/overview.ts`, domain schema, `openapi.json` | `overview.test.ts`: margins equal the planner's grouped totals; the attention list is ordered by `|ahead_of_plan_abs|`; ended budgets absent; the endpoint answers in < 1.5 s on the golden | 3 |
| HO-011 | Header controls: `<PeriodPicker/>` extracted from Budgets and used on both screens; the as-of chip; Compare to; the staleness banner | `features/explorer/period-picker.tsx`, `routes/w.$ws.budgets.tsx`, `routes/w.$ws.index.tsx` | Playwright: a fiscal quarter chosen on the Overview yields the same range as on Budgets; Compare to shows the delta line | 1.5 |
| HO-012 | Headline v2: four tiles, the assigned bar, remaining, projected only with projections, the since-plan line | `features/overview/headline.tsx` | Playwright on the golden: no Projected tile; on a fixture with projection facts: shown with its source; OpenAI workspace: the bar reads 30M of 150M | 1 |
| HO-013 | Heatmap v2: margins, band tints, alert dots, popover with two actions, arrow-key navigation, sort, legend chips; ranked list on phones | `features/overview/heatmap.tsx`, `cell-popover.tsx` | Playwright: totals row and column present and equal to the API; arrow keys move focus; "Edit these budgets" opens the cell editor; 375 px shows the list | 2.5 |
| HO-014 | Needs attention, Alerts by rule, KPI bullet bars, Approvals queue, Data footer | `features/overview/attention.tsx`, `alerts-by-rule.tsx`, `kpi.tsx`, `queue.tsx`, `data.tsx` | Playwright: the first attention row is the largest `|ahead of plan|` on the golden; "CPA over target" opens Alerts filtered by rule; queue counts equal `/approvals` | 2 |
| HO-015 | Customise v2: reorder, remembered axes and sort, "Set as workspace default" for admins; `OverviewLayout` schema | `features/overview/customise.tsx`, `packages/domain/src/views.ts` | Playwright: an admin sets the default; a fresh finance user sees it; the order survives a reload | 1 |

### Phase G4 — polish (≈ 3 days)

| ID | Task | Files (main) | Done when | Days |
|---|---|---|---|---|
| HO-016 | Mobile pass for both screens (Decision D7), dark-mode check of the new tints, 12 px minimum, focus rings | both features | `a11y.spec.ts` extended to the new controls; snapshots at 375 in both themes | 1.5 |
| HO-017 | Performance and docs: the Overview render budget test kept, Home skeleton parity, runbook note on the freshness threshold, `TASKS_STATUS`, ADR index | tests, `docs/runbooks/`, `docs/TASKS_STATUS.md` | `pnpm test:acceptance` green; `pnpm bench` unchanged | 1.5 |

Total ≈ 29 days. Order: G1 first (HO-001 → HO-004); G2 and G3 can run in parallel after HO-003; G4 last.

---

## 6. Decisions for the product owner

| # | Decision | Proposal |
|---|---|---|
| G1 | Home's four summary tiles: keep them, or replace them with a one-line pulse that links to the Overview | **One-line pulse**, the same component and fields as the Overview headline |
| G2 | Compute "time gone" and pace as of the last day the actuals cover instead of today | **Yes**, with the as-of chip always visible; an ADR amends ADR-047's inputs. A monthly fact covers its whole month. |
| G3 | Alerts: group by rule on the Overview; and review the two default CPA rules that fire on 106 of 193 leaves | **Group by rule** now; thresholds are the owner's call, and a "rule health" hint points at them |
| G4 | Deciding approvals from Home: a side sheet with the full detail, or a link only | **Side sheet** reusing the approval detail parts; the full page stays one click away |
| G5 | Who sees "Data to map" on Home | **Only people who can map** (`source.manage`) |
| G6 | The ranking behind "Needs attention" | **Money ahead or behind plan** (`actual − budget_in_period × elapsed`) with categories; over and under in one list |
| G7 | The staleness threshold | **Two days** for a daily source; a monthly source is stale when last month is still missing ten days after it ended; per-source cadence later |
| G8 | Overview default axes and layout for the team | **Admins set a workspace default** from Customise (the API allows it today) |
| G9 | The Projected close tile when no projections are loaded | **Hide it**; Data says "no projections loaded" |
| G10 | The Overview on phones | **Ranked lists**; the heatmap is desktop-only and says so |

---

## Appendix A — evidence

Screenshots taken on 2026-09-29 in the built-in browser (not stored in the repo): Home as `orgAdmin`, `budgetOwner` and `planner` at 1440×900 and at 375 px; the Overview at the top, scrolled, at 375 px, and as `planner`; the OpenAI workspace's Home and Overview; Budgets, Approvals and Alerts for the visual grammar. API probes with the persona tokens: `GET /alerts?status=OPEN&limit=500`, `GET /workspaces/:ws/overview?period=current_year`, `GET /me/home` for six personas, `GET /approvals?assignee=me&status=PENDING,ESCALATED`. Re-run against `pnpm dev:local` with `apps/web/e2e/.auth-local/tokens.json`.

Code read: `apps/web/src/routes/w.$ws.home.tsx`, `w.$ws.index.tsx`, `w.$ws.tsx`, `components/shell.tsx`, `components/page.tsx`, `features/home/*`, `features/overview/cell-editor.tsx`; `apps/api/src/modules/home/home.ts`, `modules/overview/overview.ts`, `modules/pacing/queries.ts`; `packages/domain/src/home.ts`, `filter-ast.ts`, `pacing.ts`, `views.ts`; `packages/ui/src/*`; `packages/db/seed/defaults.rules.ts`, `defaults.tours.ts`, `iso-countries.ts`; ADR-029, 035, 045, 047, 051; spec §18, §27; plan §2.2, §3, §8.4, §10, §11; `docs/UX_AUDIT_AND_ADMIN_PLAN.md`; `apps/web/e2e/overview.spec.ts`, `home-tours.spec.ts`.
