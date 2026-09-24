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

## Notes

Added 2026-09-23 on `task/bench-macos`. The decision and the recorded numbers above are unchanged.

- Chrome is resolved by `scripts/chrome-path.mjs`: `CHROME_PATH` first, then the macOS app bundle, then `google-chrome`, `google-chrome-stable`, `chromium` or `chromium-browser` on `PATH`. The timeline bench uses the same helper.
- On an Apple Silicon Mac the grid-core bench failed its 10% check. The glide visible-window ratio was 0.4415 and the limit was 0.4144. The cause was contention, not the machine. turbo ran the grid, timeline and query-planner benches at the same time, and vitest ran `grid-core.bench.ts` beside `budget-grid.bench.ts`, so headless Chrome shared the CPU with the timed loops. The glide window sample was 3.0–4.6 ms when grid-core ran alone and 10.6 ms inside `pnpm bench`. `turbo.json` now runs grid, then timeline, then query-planner. The grid bench config sets `fileParallelism: false`.
- `cpuScaleMs` now discards 2 warm-up loops and takes the median of the next 9. Before, it took the median of 5 with no warm-up. Across 5 runs on that Mac the old calibration moved between 16.4 and 24.3 ms. The new one moved between 16.7 and 17.0 ms. The visible-window statistic is still the p50 of 80-pass batches. It now takes 31 batches instead of 15. The 10% and 2× limits are unchanged.
- The CPU-normalised ratios still depend on the machine. The calibration loop is integer arithmetic. The timed work allocates objects and reads strings. On the arm64 Mac, `cpuScaleMs` was higher than the Linux baseline, but the grid work ran faster. The glide window ratio came out near 0.28, against a limit of 0.414. A regression there would have to be close to 50% before the gate failed. The gate is only tight on hardware like the machine that recorded the baseline. To tighten it elsewhere, re-record `baseline.json` on the reference CI runner. Do not loosen the limits.
