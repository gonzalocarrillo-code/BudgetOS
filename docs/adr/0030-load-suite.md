# ADR-030: The CI load suite at spec scale

## Status

Accepted.

## Context

T-034 (spec §21, plan Appendix C, phase 17) needs `scripts/load-test.ts` to scale the golden generator to about 100k leaves, 20 dimensions, 5 templates, 30M facts and 1M comments, and to assert the Appendix C targets in a CI job. It is not a laptop default. The dataset is never shrunk to go green: if the runner cannot hold it, the job fails and records the limit.

## Decision

- **Dataset** (`apps/api/src/load/scale.ts`):
  - the golden workspace is seeded through the real commands;
  - the registry commands add `load_shard` (one value per copy) and `agency_team`, for 20 dimensions, plus two templates, "Shard first" and "Team first", for 5;
  - the live golden tree (193 leaves, 331 envelopes) is copied **521 times** by bulk SQL, for **100,553 leaves** and about 172k envelopes, each copy with its own approved version (golden phasing × a per-shard factor, amount = exact sum), `envelope_dimension` rows, and the shard and team values;
  - facts: daily spend Jan–Aug (243 days) plus weekly conversions and revenue (35 weeks), about 24.4M + 7.0M = **31.4M facts**;
  - one thread per copied leaf with 10 comments, about **1M comments**; 10% of leaves tagged;
  - the copies are bulk SQL because the commands write an audit row per change and would take hours at this size; the job measures reads plus the write paths it drives itself through the API.
- **Derived data built by the real code:**
  - the search index through the document builders, in batches of IDs (`reindexWorkspace` holds a whole type in one transaction and would not survive 1M comments), about 1.2M documents;
  - the roll-up cache through `rebuildWorkspace`, all 5 templates.
- **Measurements** (`apps/api/src/load/measure.ts`, through the API in-process with the real auth, guards and planner; network excluded), each p95 over `LOAD_ITERATIONS` (20) after 2 warm-ups:

  | Measure | What is run |
  |---|---|
  | Grid queries | Explorer-shaped: tree root, a country expand, a deep expand, a leaf page, the country × platform pivot, a shard filter |
  | Search | text, qualifiers, tag, fuzzy |
  | Inline edit | `PATCH /envelopes/:id/draft` |
  | 10k bulk | preview, then commit of a +1% on 10,000 copied leaves |
  | Derived-data lag | a minor change through the API (auto-approved), then its outbox rows through the roll-up and search push handlers, timed from the change's start to each handler done |

  - Each measurement records its result even when another fails. The report (`load-report.json`) has the scale, the phase timings and every p95 with its target. Exit 1 when any target is missed or any step fails.
- **CI job** (`.github/workflows/load.yml`):
  - runs nightly at 03:00 UTC, on demand, and on pushes to `task/T-034-*` (not on every PR);
  - Postgres 16 runs with its data on the runner's `/mnt` and settings for a bulk load;
  - the runner's CPU, memory and disk are logged with the report;
  - the step summary tables the results, and the report is uploaded as an artifact.
- **What is not measured here:**
  - the UI's 200 ms interaction target (T-026c measured the grid at 100k in-memory rows);
  - availability and freshness against real sources (cloud).

## Consequences

- First findings at small scale (5 shards, 1.2k leaves, 0.3M facts):
  - search p95 70 ms and inline edit p95 25 ms are well inside their targets;
  - the tree-root and pivot queries are already about 460 ms against 400. They request `projected`, the planner measure found costly in T-033 (a follow-up task speeds it up). At spec scale the grid target is expected to fail until that lands.
- The job is red until every Appendix C target holds at spec scale. TASKS_STATUS keeps T-034 `blocked` on it, with the numbers.
