# ADR-003: Timeline core

## Status

Accepted.

## Context

Epic 0.8 and spec §22 T-026b require a measured choice between `@svar-ui/react-gantt` (MIT core), `vis-timeline`, and a custom canvas before `@budget/timeline` builds on one of them. Plan §11.9 already names the SVAR core. The spike still had to measure all three, including a target lane and our marker overlay.

The large database golden does not exist yet. Finding 2 in `docs/LOCAL_BUILD_PHASES.md` says this spike uses 5,000 in-memory bars. The database-scale proof is T-034, not this spike.

Each engine received the same 5,000 bars: 1,000 envelopes, three target children each (`budget`, `cpa`, `roas`), and one experiment child. `@svar-ui/react-gantt` is 2.7.2. `vis-timeline` is 8.5.4, standalone build. The canvas draws only the rows inside the viewport. No `@svar-ui` package with `pro` in the name is installed. The MIT store clears `markers` on init, so the PRO vertical-marker API is not available.

Sample definitions, committed in `packages/timeline/bench/baseline.json`:

- `svarRenderP95Ms`, `visRenderP95Ms`, and `canvasRenderP95Ms`: p95 of 7 remounts after one warmup. A remount is finished when the first bar is in the document, or when the canvas has been painted.
- `cpuScaleMs`: median of five fixed CPU loops in the same process, taken before the browser samples. `pnpm bench` divides each render sample by this scale and fails when that ratio is more than 10% above the committed ratio.
- `svarPanFpsP50`, `visPanFpsP50`, and `canvasPanFpsP50`: p50 frame rate in headless Chrome at 1280×800 while panning for 1.6 s after a 0.4 s warmup. The bench fails when fps is more than 10% below this file. Pan fps is not divided by `cpuScaleMs`.

The target lane and the marker overlay were checked in the browser for every engine before the 5,000-bar samples. The fixture is one envelope, a budget target child, and a CPA target that stays collapsed. Markers are our absolutely positioned layer. Two markers one day apart share a cluster when they are under 6 px apart. The closure marker does not. The page fails if a `.wx-marker` node from SVAR is present.

## Decision

Rendering engine: @svar-ui/react-gantt

Recorded numbers:

- cpuScaleMs: 13.991
- svarRenderP95Ms: 372.900
- visRenderP95Ms: 13625.700
- canvasRenderP95Ms: 16.900
- svarPanFpsP50: 59.9
- visPanFpsP50: 59.9
- canvasPanFpsP50: 59.9

SVAR painted 5,000 hierarchical bars in 372.900 ms p95 and panned at 59.9 fps p50. The budget target rendered on its own lane. The marker overlay is ours. vis-timeline also rendered the lane and the overlay, then took 13625.700 ms p95 to mount the same 5,000 rows. The canvas viewport paint was 16.900 ms p95 at the same 59.9 fps, without a task grid, zoomable scales, or hierarchy. Spec §23.2 keeps the package on the SVAR core when that core can render the target lane and the overlay. It can.

## Consequences

- T-037 builds `BudgetTimeline` on `@svar-ui/react-gantt`: fiscal scales, bar templates, the marker overlay, the today line, and the as-of scrubber. These devDependencies move to runtime dependencies in that task. The component stays read-only in Phase 1.
- SVAR's `open` flag walks `task.data`. A leaf with `open: true` and no children throws, because the store calls `forEach` on null. The spike passes `open: true` only for tasks that have children. "Collapsed except the budget metric" is which target rows are passed in, not `open` on the leaf.
- The 5,000-bar database proof is T-034. This ADR does not claim that proof. SVAR's 372.900 ms p95 is under the later T-037 gate of 500 ms, and this spike does not mark that gate done.
- All three engines held 59.9 fps p50 while panning the visible viewport, which is one frame at 60 Hz.
