# @budget/timeline

Rendering engine: @svar-ui/react-gantt

T-026b measured `@svar-ui/react-gantt` 2.7.2 against `vis-timeline` 8.5.4 and a custom canvas on 5,000 in-memory bars. All three showed a budget target on its own lane under the envelope and a marker overlay that clusters marks under 6 px. SVAR's first paint was 372.900 ms p95 and the pan was 59.9 fps p50. vis-timeline's mount was 13625.700 ms p95. The canvas viewport paint was 16.900 ms p95 and does not include a task grid or zoom. The numbers and the decision are in `docs/adr/0003-timeline-core.md`.

`BudgetTimeline` (T-037, ADR-032) renders a `TimelineResponse` from `GET /workspaces/:ws/timeline`. It adds:

- fiscal scales (registered SVAR units for fiscal years that do not start in January);
- bar templates: spend fill, projected-close tick and pace colour; thin target lanes with their effective ranges;
- our marker overlay, the today line and the as-of scrubber.

It is read-only in Phase 1. `pnpm bench` mounts it with 5,000 bars and fails at 500 ms p95 or later. No SVAR PRO package may be imported (`scripts/forbidden-packages.mjs`, eslint and license-check).
