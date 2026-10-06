# ADR-085: One-to-one fact → budget matching (match rules, ambiguity, coverage)

## Status

Accepted (EX-1).

## Context

Facts carry arbitrary dimensions in `dimension_values` (a source mapping decides which; `campaign`
is just a key). `matchRunFacts` (spec §24.3) sent a fact to the live, date-covering envelope whose
tuple is the largest subset of the fact's, and broke ties by envelope id: two budgets with the same
tuple silently split facts by uuid order. There was no way to say "this campaign belongs to that
budget" other than the per-tuple manual assignment of the unmatched queue, which only works for
facts that matched nothing, and nothing showed how much spend was assigned overall. The owner asked
for assignment that is 1:1, scalable and source-agnostic: every fact on exactly one budget, or
visibly unassigned or ambiguous, never on an arbitrary one.

## Decision

1. **Match rules are registry rows.** `match_rule (workspace_id, id, envelope_id, predicate jsonb,
   start_date?, end_date?, created_by, created_at, deleted_at?, deleted_by?)`, RLS enabled and
   forced (`tenant_isolation`), SELECT for `budget_mcp`, in the purge list, soft-deleted only.
   `predicate` is a FilterGroup over **fact** `dimension_values` (`MatchRulePredicate` in
   `@budget/domain`: dimension fields only; eq, neq, in, nin, contains, starts_with, is_empty,
   not_empty; never empty). Nothing is named after a business concept: a rule on `campaign`, on
   `adset`, or on any mix of keys is the same row, whatever the source.
2. **One evaluator in SQL.** `match_rule_matches(predicate jsonb, dims jsonb)` (IMMUTABLE plpgsql)
   evaluates a rule's predicate against a fact. Matching is one statement per fact table whatever
   the number of rules; no rule is ever compiled into SQL text. A rule-scoped re-match adds a jsonb
   containment pre-filter (`dimension_values @> {"campaign": …}`) for a top-level `eq`, which the
   existing GIN index serves.
3. **Order: manual pin > match rules > tuple.** `matchFacts` (`packages/db/src/facts.ts`) decides,
   per fact in scope: a `manual` fact is out of scope; then the distinct live (not ARCHIVED),
   date-covering envelopes of every live rule whose predicate holds and whose own window covers
   the date; if none, the tuple candidates at the highest key count (unchanged rule). Exactly one
   candidate → assigned (`match_method` `rule`, or `tuple` / the normalizer's `external_id` /
   `match_key`). Several candidates **on one ancestor chain** (each an ancestor of the next, e.g. a
   parent and its child with identical tuples, or rules naming both) → the **deepest** takes the
   fact with the same method (money lives on leaves, ADR-016). Several candidates **not** on one
   chain (siblings, cousins, unrelated budgets) → **ambiguous**. None → unmatched. **Never
   tie-broken by id.** A rule conflict does not fall through to the tuple: the same chain rule
   decides it, and otherwise it is ambiguous.
4. **Ambiguity is its own nullable column**, not a `match_method` value: `match_status text NULL
   CHECK (match_status IN ('ambiguous'))` plus `match_candidates uuid[] NULL` on `spend_fact`,
   `kpi_fact`, `projection_fact`, with `envelope_id` NULL. `match_method` describes *how a fact
   matched*; an ambiguous fact did not match, and putting `ambiguous` there would let the previous
   code's `coalesce(match_method, 'tuple')` mark an assigned fact as ambiguous during a deploy. The
   new columns are additive (expand/contract): the previous code never reads them and keeps
   working; ambiguous facts look unmatched to it (envelope NULL), which is what they are.
   `match_method`'s CHECK gains `rule`.
5. **Re-matching.** The ingest run's pass is `matchFacts({ runId })` (the run's facts without an
   envelope). Creating or deleting a rule re-matches, in the same transaction, the live unpinned
   facts its predicate covers; `POST /workspaces/:ws/match-rules/rematch` (source.manage)
   re-matches the whole workspace. Facts dated in a closing/closed period are left alone (their
   actuals are frozen until restated). Each write emits one audit_event (`match_rule.created`,
   `match_rule.deleted`, `facts.rematched`) and one `facts.loaded` outbox row naming the envelopes
   that gained or lost facts, so the roll-up worker refreshes them.
6. **Permissions.** Writing or deleting a rule needs `envelope.edit_draft` on the route and in the
   target budget's dimension scope (`assertInScope`). Listing rules is `envelope.read`. Coverage
   and the workspace re-match are data operations (`source.manage`), like the unmatched queue.
7. **Coverage.** `GET /workspaces/:ws/match-coverage?from&to&limit`: live (non-superseded) spend in
   reporting currency as Decimal strings with row counts, split matched / unmatched / ambiguous
   (each fact is in exactly one, so the three add up to the period's total), by source and by
   campaign, plus the unmatched and ambiguous campaigns (with the tied budgets) largest first.
   The period is `from` / `to` dates (both optional, inclusive), the simplest form that covers
   "the period" and custom windows.

## Consequences

- A parent and a child with the same tuple send their facts to the child (deepest on the chain),
  not to whichever uuid sorts first. Siblings or unrelated budgets with the same tuple leave the
  facts ambiguous: the spend shows in the Campaign mapping with the budgets as candidates, and a
  rule (or a more specific tuple) settles it.
- A budget that is created or re-dated after facts loaded still does not pull unmatched facts by
  itself (unchanged); a rule, the workspace re-match, or the unmatched queue does.
- A rule only assigns inside its budget's dates: a campaign running past its budget's end is
  unmatched for those days, not moved to another budget.
- Coverage counts demo facts like any other (the page is a data-operations view).
- The web Spend data page's "Campaign mapping" creates `campaign = value` rules; richer predicates
  are API-only for now.
