# ADR-002: Grid core

## Status

Accepted.

## Context

Epic 0.7 and spec §22 T-026a require a measured choice between `@glideapps/glide-data-grid` and a TanStack-only grid before `@budget/grid` builds on one of them. Plan §11.9 already names Glide as the rendering engine. The spike still had to measure both.

The large database golden does not exist yet. Finding 2 in `docs/LOCAL_BUILD_PHASES.md` says this spike uses 100,000 in-memory rows. The database-scale proof is T-034, not this spike.

Both engines read the same 100,000 by 12 in-memory rows (`path`, `budget`, `actual`, `projected`, `varianceAbs`, `variancePct`, `remaining`, `paceIndex`, `target`, `status`, `chips`, `dimension`). The TanStack-only build is `@tanstack/react-table` 8.21.3 plus `@tanstack/react-virtual` 3.14.13. An unvirtualized DOM table of 100,000 rows was not mounted. Glide is 6.0.3. Cells are `GridCellKind.Text`. Budget renderers, editors, and paste belong to T-026c.

Sample definitions, committed in `packages/grid/bench/baseline.json`:

- `glideVisibleWindowP50Ms` and `tanstackVisibleWindowP50Ms`: p50 of 15 samples. Each sample is 80 passes over the visible index list from `@tanstack/virtual-core` `defaultRangeExtractor` (32 rows, overscan 5, 12 columns).
- `glideGetCellMedianMs` and `tanstackGetCellMedianMs`: median of 21 samples. Each sample reads 8,000 rows by 12 columns. Glide constructs one text cell per column. TanStack calls `getVisibleCells()` once per row, then `getValue()`. A short sample's p95 tracked one garbage-collection pause, so the committed statistic is the median of a longer sample.
- `glideModelBuildMs`: median of 3 samples of 100 first-window reads. Glide has no row model.
- `tanstackModelBuildMs`: median of 3 samples of `createTable` plus `getRowModel()` on the 100,000-row array.
- `cpuScaleMs`: median of five fixed CPU loops in the same process. `pnpm bench` divides the visible-window and model-build samples by this scale and fails when that ratio is more than 10% above the committed ratio. The cell-batch median uses the same scale and fails above 2×, because that sample moved by about 45% between runs (22.893 ms, then 33.059 ms) without changing which engine was faster. Scroll fps is not divided by `cpuScaleMs`.
- `glideScrollFpsP50` and `tanstackScrollFpsP50`: p50 frame rate in headless Chrome at 1280×800 while scrolling for 1.6 s after a 0.4 s warmup. The bench fails when fps is more than 10% below this file. Scroll fps is not divided by `cpuScaleMs`.

## Decision

Rendering engine: @glideapps/glide-data-grid

Recorded numbers:

- cpuScaleMs: 13.848
- glideVisibleWindowP50Ms: 5.217
- tanstackVisibleWindowP50Ms: 61.591
- glideGetCellMedianMs: 12.548
- tanstackGetCellMedianMs: 22.893
- glideModelBuildMs: 5.732
- tanstackModelBuildMs: 621.418
- glideScrollFpsP50: 59.9
- tanstackScrollFpsP50: 59.9

Both engines held 59.9 fps p50 while scrolling the visible viewport, which is one frame at 60 Hz. The visible-window sample was 5.217 ms for Glide and 61.591 ms for TanStack. A sequential read of 8,000 rows was 12.548 ms versus 22.893 ms. TanStack's core row model materializes all 100,000 rows in 621.418 ms. Glide does not. Spec §18.2's `BudgetGrid` wraps `DataEditor`. TanStack Table stays available for column state, as plan §11.5 describes. It is not the renderer.

## Consequences

- T-026c builds `RowSource`, budget cell renderers, editors, paste, and the package fps gate on Glide. These devDependencies move to runtime dependencies in that task.
- `@glideapps/glide-data-grid` 6.0.3 declares a React peer of 16–18. This spike rendered it with React 19.2.4, which spec §2 requires. pnpm reports an unmet peer. The scroll bench still mounted `DataEditor`.
- The 100,000-leaf database golden is T-034. This ADR does not claim that proof.
- Plan epic 0.7 still says 60 fps at 100k envelopes on the golden dataset. T-026c's gate is 55 fps p50 on in-memory rows. This spike's 59.9 fps is the headless Chrome scroll of text cells, not that later gate.
