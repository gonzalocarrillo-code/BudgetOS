# ADR-038: The Explorer's tree is served from the roll-up cache

## Status

Accepted.

## Context

Plan §5.3 says roll-ups are not computed on read: the grid reads `rollup_cache`. T-022 built the cache and `compileTree`, but no route read it. The Explorer asked `/query` for every tree level, which at 100k leaves means a full pass over every leaf for each level.

The cache also could not be kept at scale:

- A full build ran one planner query per depth, including the root over every leaf.
- It took more than 18 min at 11.8k leaves, and failed its 15 min bound at spec scale.
- A refresh re-queried the root and each ancestor over all leaves. Roll-up lag at spec scale expired its 2 min bound.

## Decision

**Read path.** `POST /workspaces/:ws/tree {templateId, period, parentPath, measures}` returns one level from `rollup_cache`:

- rows in the shape `/query` returns for groups;
- the root node as `totals`;
- the workspace's `dataVersion`, and the oldest `cacheVersion` among the returned nodes.

It answers `available: false` in two cases, and the caller asks `/query` instead:

- **`scoped`:** the caller has a scoped read role. The cache holds workspace-wide totals, and `/query` cuts rows to the caller's scope.
- **`not_cached`:** the cache does not hold the period.

The Explorer uses it for tree levels when there is no filter and no as-of date. Envelopes below the last level, the pivot, filtered trees and as-of trees still use `/query`.

**Cached periods.** Each template is cached for the fiscal year and the current fiscal quarter (the Explorer's default), plus any period already cached.

**Build.** One planner query per template and period, at the deepest level only. Each level above, and the root, is the sum of its children: every level partitions the same live leaves, and a missing dimension is its own ∅ node.

- Ratios (pace index, spend-to-date, projected close, variance %) are recomputed from the sums with the planner's formulas; they are never averaged.
- `variance_abs` is summed per envelope, as the planner does.
- `templateNodes` (also used by closures) builds the same way.

**Refresh.** For a change:

1. The changed envelopes' deepest nodes are recomputed through the planner. Their envelopes are resolved first (`envelopesUnderPrefixes`: the value ids' envelope sets, intersected) and passed as `CompileOptions.envelopeIds`.
2. Each ancestor, up to the root, is recomputed as the sum of its cached children.
3. The envelope that *is* a node is looked up only for the touched paths (`envelopesByTuple`). The old code read every envelope of the workspace.

**Planner.** Dimension predicates compile to `e.id [NOT] IN (the value's envelopes)` instead of a correlated `EXISTS`. Inside an OR, Postgres hashes each set once instead of probing it per row. They are equivalent because `envelope_id` is never null.

**One roll-up writer per workspace at a time.** Every refresh upserts the root and shared ancestors. Two concurrent deliveries, or a delivery and a rebuild, would lock the same rows in different orders and deadlock. Each roll-up transaction takes a per-workspace advisory lock first (`lockRollup`); different workspaces still run in parallel.

**Ratios for the reading day.** Pace depends on today, and a cached node only changes when its data does. `/tree` recomputes the ratios (pace index, spend-to-date, projected close, variance %) from the cached sums for the request's day, with the shared `groupRatios` / `elapsedFraction` from `@budget/domain`. The worker stores the same formulas for closures.

**Local delivery.** There is no Pub/Sub locally. The local runner (Playwright stack and `pnpm dev:local`) now delivers the roll-up worker's topics as well as `ingest.requested`: `budget.changed`, `facts.loaded`, `registry.changed` and `naming.changed`. It serves the newest workspace first, so a workspace a crashed run left behind cannot starve the live one.

**The golden seed marks its events delivered** after its own full re-index and roll-up rebuild, which already applied them. The runner then does not replay thousands of superseded events; events after that point are delivered as usual.

## Consequences

**Measured locally** at 19.5k leaves (untuned Postgres):

| | before | after |
|---|---|---|
| Full rebuild, 5 templates × 2 periods | > 15 min (timed out) | 24 s |
| One-leaf refresh, per template and period | 2–3.7 s | 76–221 ms |
| Tree level via `/tree` (p95) | 0.6–3.3 s via `/query` | 7–9 ms |

**Freshness.** A tree level shows the cache as of its last refresh. After an edit, parents catch up when the roll-up worker handles the event; the target is < 5 s. Responses carry both versions so a client can tell.

**Still slow.** The pivot and large filtered pages still go through `/query` and scale with the leaves they cover.

**Tests:**

- `golden.test.ts`: each `/tree` level equals `/query`'s groups; scoped callers and uncached periods get `available: false`.
- `rollup.test.ts`: after a refresh, the cache equals a full rebuild in every measure and period.
- `explorer.spec.ts`: the Explorer's tree levels come from `/tree`.
