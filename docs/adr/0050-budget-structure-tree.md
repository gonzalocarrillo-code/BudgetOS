# ADR-050: Budgets opens on the budget structure

## Status

Accepted. This amends spec §18.2 (the Explorer tree) and §23 (the timeline). The hierarchy templates of spec §8 stay; they become one option.

## Context

Product feedback (2026-09-28): "huge bug… I had FY2026 Media as parent and I no longer see it… the 150M budget disappeared."

The person had built:

- FY2026 Media: 150M
  - Paid Social: 50M
    - LATAM: 20M
  - Paid Search: 100M
    - LATAM: 10M

Every row was approved and intact.

Budgets and the Timeline only ever grouped the live *leaves* by a hierarchy template's granularities (ADR-016, ADR-038). As a result:

- **Parents disappeared.** A parent is never a leaf, so FY2026 Media, Paid Social and Paid Search had no rows.
- **Siblings merged.** The Default template has no Channel level, so the two LATAMs merged into one group.
- **The total disagreed with the rows.** The totals row read 180M while the rows added up to 30M.

## Decision

- **Planner.**
  - `QueryRequest.subtree`: each flat row's `actual` and `projected` are its own plus every live envelope under it, walked by parent links (`WITH RECURSIVE`). `budget` stays the row's own approved amount, the cap. Rows carry `childCount` and `parentId`.
  - A new filter attribute, `parent_id` (`eq`, `in`, `is_empty`, `not_empty`).
  - The projection tail (ADR-030) is off for subtree queries.
- **Default view.** Budgets opens on **Budget structure** (no `templateId` in the URL): top-level budgets, then each budget's children, every row one budget. The hierarchy picker still offers the templates, which regroup the leaves by granularities as before (roll-up cache and all).
- **Timeline.** `GET /timeline?structure=true` lists every live budget, parents included, nested by parent links and ordered depth-first. It's used whenever Budget structure is picked.

## Consequences

- Structure rows are always read through `/query` (no roll-up cache). A level is one query, and the subtree walk is bounded by the workspace's envelopes in the period.
- Under Budget structure, totals are the top-level budgets' sums, which is what the person set.
