# @budget/timeline

Rendering engine: @svar-ui/react-gantt

T-026b measured `@svar-ui/react-gantt` 2.7.2 against `vis-timeline` 8.5.4 and a custom canvas on 5,000 in-memory bars. All three showed a budget target on its own lane under the envelope and a marker overlay that clusters marks under 6 px. SVAR's first paint was 372.900 ms p95 and the pan was 59.9 fps p50. vis-timeline's mount was 13625.700 ms p95. The canvas viewport paint was 16.900 ms p95 and does not include a task grid or zoom. The numbers and the decision are in `docs/adr/0003-timeline-core.md`.

`BudgetTimeline` (fiscal scales, bar templates, marker overlay, today line, as-of scrubber) is T-037. The database golden at scale is T-034.
