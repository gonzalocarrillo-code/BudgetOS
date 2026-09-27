# ADR-033: Experiments

## Status

Accepted.

## Context

T-038 (spec §25, plan §4.12) adds experiments, which are test budgets with a question attached. The pieces are:

- the tables;
- the commands;
- a read-out of test against control;
- a lane on the Gantt timeline;
- the search qualifier `experiment:<status>`;
- the Experiments screens.

The done-when:

- The weighted CPA of test against control equals the planner's numbers.
- Concluding requires a decision and posts a thread comment.

The spec is silent on:

- permissions;
- how the linked envelopes relate to the scope filters;
- what concluding with nothing linked means.

It also leaves `workspace_id` off `experiment_envelope`.

## Decision

**Tables.** The migration `20260927000000_experiments` (§25.1's `0005_experiments`, dated like every migration since 0003) creates the tables and enums of §25.1. Both tables have RLS, and `budget_mcp` gets SELECT on them. `experiment_envelope` also carries `workspace_id`, because AGENTS §4 requires it on every tenant table.

**Scope of each side.** A side's scope is its filter (when the filter has predicates) OR the envelopes linked in that role, restricted to live leaves (ADR-016). The window is the experiment's start to end date. The scope is cut to the caller's read scope, the same rule as `/query`.

A new FilterGroup attribute, `experiment`, expresses "linked to an experiment". Its value is one of:

- a status (`RUNNING`);
- an experiment id;
- `<id>:TEST` or `<id>:CONTROL`.

The planner compiles it, so the Explorer, saved views and alerts can filter by it too.

**Read-out.**

- **MetricSet.** Each side is `compileTotals` over its scope, with measures `budget` and `actual` and the primary metric as a target KPI. The metric is the planner's Σnumerator / Σdenominator: CPA is Σspend / Σconversions, never an average of the leaves' CPAs.
- **Delta.** It is test minus the reference. The reference is the control's metric, or the criterion's `value` when the criterion is absolute.
- **criterionMet.** It is `null` until `minDays` have run, and while either side has no metric.
- **daysRunning.** It counts from the start date to today, the end date or the decision, whichever comes first. It is 0 while the experiment is PLANNED.

**Commands.** Each write emits one `experiment.*` audit_event and one `experiment.changed` outbox row.

- **Linking** upserts the role. Linking a TEST envelope applies the system tag `experiment` (tag kind `system`, created on first use).
- **Moves:**
  - start: PLANNED → RUNNING;
  - evaluate: RUNNING → EVALUATING;
  - abandon: from any non-final status;
  - conclude: RUNNING or EVALUATING → CONCLUDED.
- **Final states.** CONCLUDED and ABANDONED are final: no edits, no links.
- **Concluding:**
  - It needs a decision of at least 20 characters.
  - It needs at least one linked envelope, because the decision must land in the envelopes' Decision Timeline.
  - It posts one thread per linked envelope, titled "Experiment concluded: …", with the decision as the first comment.
  - Those threads are written through the threads command's new `createThreadIn`, so each carries its own `thread.created` audit and `thread.changed` outbox row for notify and search.

**Permissions.** No experiment actions are specified, and new ones would change every role in the permission matrix.

- Reads need `envelope.read`.
- Writes need `envelope.edit_draft` (a test is a budget change in the making).
- Linking also checks the envelope's dimension scope.

**Search.** `experiment` is an indexed type (name, hypothesis, decision; status; the window's fiscal period), and it is workspace-wide like tags.

- `experiment:<status>` matches experiments in that status and the envelopes linked to one.
- The `experiment.changed` topic re-indexes the experiment and its envelopes, which picks up the new tag.
- The deep link is `/experiments/:id`.

**Timeline.** `GET /timeline` returns `kind:'experiment'` bars under each linked envelope:

- the bar is the evaluation window;
- `status` is `<STATUS> · <ROLE>`;
- only experiments created by `asOf` are included.

Like non-budget targets, the lanes are hidden until their envelope is opened.

**Golden.** The seed has one running platform test, TikTok vs Meta on prospecting, with one TEST and one CONTROL envelope linked. `golden.assertions.ts` records each side's live leaves and weighted CPA, computed from the plan's facts. The search counts include the experiment and the system tag.

## Consequences

- The read-out, the Explorer and the timeline agree, because they are the same planner SQL over the same filter.
- An experiment defined only by filters must link at least one budget before it can be concluded.
- A dedicated `experiment.manage` action, and statistical significance (plan Phase 3), are left for later ADRs.
