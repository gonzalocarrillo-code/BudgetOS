# ADR-034: Manual result entry

## Status

Accepted.

## Context

T-039 (spec §26, plan §6.1) adds manual result entry. Offline and non-integrated actuals (TV, out of home, print, radio, sponsorships) are typed or pasted into a grid, one batch per channel and period, and sent for approval. Approved rows become spend and KPI facts.

The done-when:

- An approved batch appears in `/query` actuals with `source_system='manual'` and lineage.
- A rejected batch reopens as a draft.

The spec is silent on:

- who may enter results;
- how invalid rows are kept;
- how a rejection's comment reaches the batch;
- that the default registry has no offline channels;
- that an approval step takes a single role, where §26.2 asks for "finance or budget_owner".

## Decision

**Tables.** The migration `20260927010000_manual_entry` (§26.1's `0006_manual_entry`) creates:

- `manual_entry_batch`, as §26.1 specifies;
- `manual_entry_fact`, the lineage §26.2 asks for. It has one row per fact an approved batch wrote: `batch_id`, `row_no`, the fact table and metric, `source_row_hash`, `period_date`, `entered_by` and `approved_by`.

Both tables have RLS and a `budget_mcp` SELECT grant.

**Rows are saved as typed.** A half-finished grid can be kept, so PATCH accepts rows of strings.

- Each create or save validates every row as ingestion does:
  - dimension values resolve against the registry (code, alias, external id; merged values follow the merge), reusing the workers' `loadRegistry`;
  - the date must lie inside the batch's period and not in a closed period (`closedPeriods`);
  - the amount must be money, and never negative;
  - the currency needs an FX rate into the reporting currency (`FxCache`);
  - KPI values must be numbers.
- Resolved values are stored as codes, and blank rows are dropped.
- The response carries the `issues` (row, field, reason) and the totals: the reporting-currency sum, plus the sum per currency.
- Rows that no live budget would take are returned as `warnings`; they would wait in the unmatched queue.
- A batch with an issue cannot be submitted (422, "Rows to fix before sending for approval: N").

**Approval.**

- `entity_type='manual_entry'` joins the approval engine's supported types (`PolicyConditions.entityType` gains the value).
- A new default policy, "Manual results" (priority 0, `{ entityType: "manual_entry" }`), needs one FINANCE approval. It is seeded with the other defaults, and existing workspaces add it through the policies screen.
- Without it, a batch would match the amount-based envelope policies. §26.2's "finance or budget_owner" would need a step that takes two roles, and chain steps take one role (spec §9.1). So the default is Finance, and a workspace can edit it.
- Approvers must cover every row's tuple, with the batch's channel. Submit also checks that the enterer's `envelope.edit_draft` scope covers every row.

**On approval**, the rows become facts:

- Rows are loaded with `source_system='manual'`, `source_run_id` = the batch id, and row hashes `sha256("manual:<batch>:<row>[:<metric>]")`.
- Each fact's tuple is the row's dimensions plus `channel`.
- `matchRunFacts` matches them to budgets exactly as an ingest run does, so `match_method` is `tuple`.
- The lineage rows are written, the batch becomes APPROVED, and the `facts.loaded` outbox row goes out (rollups, pacing and search pick it up), with `manualEntryId`.
- The last approver is recorded as `approved_by`.

**Reopening.** Reject, request changes and withdraw all reopen the batch as DRAFT, clearing its request pointer. The decision's comment is in `approval_decision`, and `GET /manual-entries/:id` returns the latest request and decision so the screen can show why the batch came back.

**Permissions.**

- Entering, saving and submitting need `envelope.edit_draft` (planners, budget owners, admins), because the people who own the budgets enter their offline results.
- Reading needs `envelope.read`.

**Channels.** The default registry's `channel` dimension gains `tv`, `ooh`, `dooh`, `print`, `radio` and `sponsorship`. `other` was already there. Channel colours come from a fixed palette by position, because `dimension_value` has no colour field. The screen gives offline channels tabs and puts the rest under "More channels".

**UI.** `/sources/manual` shows:

- the channel tabs;
- the batches for that channel;
- the batch editor: `<BudgetGrid/>` over a local `RowSource` (`EntrySource`).

In the editor:

- The chosen granularities, date, currency, note and KPIs are editable pseudo-dimension cells; the amount is an editable money cell.
- Paste fills from the anchor and grows the batch.
- Edits save after 500 ms, and the server's issues mark rows with ⚠ and are listed below the grid.
- Totals are pinned.
- "Send for approval" is disabled with the reason written out ("Rows to fix: 1 — row 2: unknown country "XX"").

The approval request page shows the batch's rows and totals.

**Golden.** The seed has one DRAFT TV batch for September. It writes no facts, so no totals move. `golden.assertions.ts` records its rows and per-currency total, and the dimension-value count includes the offline channels.

## Consequences

- Manual results reach budgets exactly as ingested facts do: the same match, rollup and pacing paths.
- A registry change can make a submitted batch fail validation at approval (422). The approver then returns it for changes.
- Two-role approval steps are left for a later ADR.
