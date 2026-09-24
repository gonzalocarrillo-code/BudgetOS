# ADR-006: planner bench warm-up and calibration

## Status

Accepted, 2026-09-23. Not a §22 task. Branch `task/planner-bench-stable`, stacked on `task/bench-macos`.

## Context

`packages/query-planner/bench/compile.bench.ts` compared the absolute p50 of 15 batches of 5000 `compileQuery` calls with `compile5000P50Ms: 11.6`. It ran 2000 warm-up calls first. On an Apple M2 it failed 1 run in 3 when run alone: 13.05 ms against a 12.76 ms limit.

Printing every batch showed two causes:

- **The warm-up was too short.** Batch times start at 10–15 ms and settle at 5.7–6.3 ms after about 15–20 batches (75k–100k calls). All 15 timed batches fell inside that V8 tier-up. Their p50 was 9.6–11.9 ms across 5 runs, and the 11.6 ms baseline came from the same window.
- **Absolute time moves with the whole process.** With a long warm-up, the absolute p50 across 8 separate runs on the same Mac was 5.74–6.84 ms (19%). In the slow runs the fastest batch was also slow (6.5 ms, against 5.6–5.7 ms). So the whole run was slower, most likely because of core placement or clock speed, not single-batch outliers.

## Decision

- Warm up with 40 batches of 5000 calls (200k), then time 31 batches instead of 15.
- Time a planner-shaped calibration batch (`bench/calibration.ts`) after each planner batch, warmed and sampled the same way. It uses template strings, parameter pushes, map/join and a regex replace. It does not import the planner, so a planner regression does not move it.
- Gate on `compileToCalibrationP50Ratio` = p50(compile) / p50(calibration). The bench fails when it is more than 10% above `baseline.json`. The 10% rule is unchanged.
- `compile5000P50Ms` and `calibration5000P50Ms` stay in `baseline.json` for the record. They are not gated.
- An integer-arithmetic loop like the grid's `cpuScaleMs` was rejected. On the M2 the two loops gave the same spread, but when the probe was forced onto the efficiency cores the integer ratio moved about 2×, from 0.41 to 0.78–0.86. The string ratio moved from 0.63 to 0.68–0.85.

### Recording method

1. Nothing else heavy running: no other bench, no `pnpm dev`, no local build.
2. `BENCH_RECORD=1 pnpm --filter @budget/query-planner bench`, 5 times. Each run overwrites `baseline.json` with its own numbers and `recordedOn` (CPU model, Node version, UTC date).
3. Commit the run whose ratio is the median of the 5.

The committed baseline is `0.6406` on an Apple M2 with Node v22.23.3 (5 recording runs: 0.6213, 0.6267, 0.6406, 0.6457, 0.675). The limit is 0.7047.

## Consequences

- On the M2, 5 runs of `pnpm --filter @budget/query-planner bench` with a load average of about 5 all passed. The ratio was 0.5746–0.6592. The highest was 6.5% under the limit. Across all 18 uncontended runs on this Mac (5 recording, 8 comparing summaries of the samples, 5 final), the highest ratio was 0.675, 4.2% under the limit.
- The calibration cancels most of a uniform slowdown, but not all of it. With 8 `yes` processes on 8 cores, absolute p50 rose about 2.5× (14.5–16.3 ms) and the ratio rose to 0.686–0.741. That failed 1 run in 3. The bench still assumes an otherwise idle machine, the same as ADR-002 `## Notes`.
- The ratio still depends on the microarchitecture. It was measured only on Apple M2 performance cores. The efficiency-core probe ran under background QoS, which also throttles, so it is only a rough proxy for another machine. On a Linux x64 CI runner the ratio may sit anywhere from well under to over 0.70. If CI fails right after this lands, or if it passes with a large margin, re-record on the reference CI runner with the method above. Do not loosen the 10% limit.
- A bench run takes about 3 s instead of about 0.4 s.
