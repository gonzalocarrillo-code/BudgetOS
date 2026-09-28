# ADR-051: One definition of "the budget" in headline numbers

## Status

Accepted. Amends ADR-016 (totals sum live leaves) for headline numbers only; the heatmap, pivots and hierarchy-template trees still sum leaves.

## Context

The UX audit (docs/UX_AUDIT_AND_ADMIN_PLAN.md, finding P0-6) found the same year's budget shown as two numbers. In the OpenAI workspace Home said USD 30,000,000 and Budgets said USD 150,000,000.

- Budgets opens on the budget structure (ADR-050): top-level budgets, each with its own approved amount and everything spent under it.
- Home and the Overview tiles summed the live leaves (ADR-016).
- Home's strip per top-level budget found its budgets by the parent's dimension values. A top-level budget with no dimensions therefore "contained" every leaf in the workspace.

Money that is approved at the top but not yet split into children (120M in that workspace) was invisible on Home.

## Decision

- **Headline numbers use the budget structure.** For a caller who reads the whole workspace, "the budget" is the top-level budgets (`TOP_LEVEL` in `@budget/domain`: no parent, not archived), queried with `subtree: true`. That is Budgets' totals row. It applies to:
  - Home's "Budget this fiscal year" and "Spent" tiles;
  - Home's strip per top-level budget: that budget's own row, found by id, not by dimension values;
  - the Overview's Budget, Spend to date and Spent tiles (`headline` in the response).
- **Scoped callers keep the leaves.** Someone whose roles cover only some values cannot read the top-level budgets above them, so their headline is the live leaves inside their scope (`basis: "scoped_leaves"`).
- **The heatmap stays on leaves.** Its cells add up to `totals` as before. The Overview's `headline.assigned` is that leaf total, and the Budget tile shows it as "… split into the budgets below" when it differs from the headline.
- `apps/api/src/common/headline.ts` is the one place that picks the basis.

## Consequences

- Home, Overview and Budgets show the same number for the same period.
- The gap between the headline and `assigned` is the money approved but not yet allocated below. It is shown, not hidden.
- A scoped person's Home total can be smaller than an admin's. That is correct: they see only what their roles cover.
- Tests: `home.test.ts` (strip = the budget's row, total = Budgets' total), `overview.test.ts` (`headline` = the top-level subtree totals, `assigned` = the heatmap total).
