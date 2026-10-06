# ADR-082: Demo data is never hidden silently

## Status

Accepted (HF-1, audit T-5 follow-up).

## Context

T-5 made the planner (`packages/query-planner/src/compile-query.ts`, the `demo_mode` CTE) exclude
demo envelopes and demo facts from every total once a workspace has any real (non-demo, non-archived)
envelope — so demo money never mixes into a real total by default. That rule is right and stays.

It had two gaps, both hit in production (workspace "Sandbox"): the user created a real budget
"Brand" as a child of the demo envelope "Brazil (demo)" › "Paid Social". The planner's exclusion then
hid every demo root, which made the Budgets page (tree, pivot and timeline) show "Start with your
first budget" with nothing underneath, Overview show only "Brand", and Slack `/budgets` show nothing
of the demo data — and because "Brand" sits under an excluded demo root, it became unreachable too.
Nothing told the user why: the exclusion is correct, but it must never be silent, and a real budget
must never be able to end up somewhere the exclusion will later strand it.

## Decision

1. **`GET /workspaces/:ws/demo-data` grows `hidden`** (`packages/domain/src/home.ts`,
   `DemoDataResponse`): `envelopes > 0 && hasRealBudgets`, the exact condition under which the
   planner's default exclusion is dropping rows the workspace still has. Existing callers are
   unaffected (additive field).
2. **The web says so.** Home, Overview and Budgets show a banner (`role="status"`,
   `data-testid="demo-hidden"`, `apps/web/src/features/workspace/demo-hidden-banner.tsx`) whenever
   `hidden` is true, with "Show demo data" (sets the URL's `demo=true`) and a link to Settings ›
   Workspace's demo-data panel. With `demo=true` every query the page sends — `/query`, `/tree`
   (bypassed in favour of `/query` so the roll-up cache, which never holds demo rows, cannot answer
   stale), the Gantt (`/timeline`) and `/overview` — carries `includeDemo: true`, and the banner's
   text switches to say totals now include demo money, with a "Hide" action back.
3. **Slack matches it.** `/budget` and `/budget list` (`apps/api/src/modules/slack/slash/budgets.ts`)
   append one context line when the caller's workspace has `hidden` true, using the same condition
   (`demoStatus`) the web banner reads.
4. **A real budget can no longer be created or moved under a demo one.** `insertEnvelopeRow` (the one
   chokepoint for every envelope insert: create, split, merge, CSV/budget-import, reintroduce-as-new)
   and `moveIn` both refuse with `DomainError('VALIDATION', …)` when the target parent is a demo
   envelope and the row being placed under it is not. Demo-under-demo (the seeder,
   `packages/db/src/demo.ts`, which never goes through this path) and real-under-real are unchanged.
   Existing misplaced rows (like "Brand") are not migrated by this change — an admin moves them out,
   now that the banner tells them to, and the workspace's own Settings › Workspace › Demo data page
   lets them purge the demo data.
5. **Settings search registry** (`packages/domain/src/settings.ts`): "Workspace templates" is removed
   (R11-004, commit 9d299b8, moved workspace creation to the org console; the entry pointed at a page
   with no route). "Demo data" now points at `/admin/workspace#demo-data`, the page's own anchor,
   instead of the same removed page. A new test (`packages/domain/src/settings.test.ts`) asserts every
   registry entry's path resolves to a route file, so this class of dead link fails CI next time.

## Consequences

- A workspace with both demo and real budgets now always says so, everywhere it would otherwise look
  emptier or smaller than it is.
- "Show demo data" is a per-visit, per-page opt-in (a URL param), never a standing setting: the
  default stays T-5's exclusion, and refreshing without `demo=true` goes back to it.
- The new structural check is enforced once, at the shared insert/move chokepoints, so it also covers
  split, merge and CSV import without separate code paths.
