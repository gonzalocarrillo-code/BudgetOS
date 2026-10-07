# ADR-0091: Demo facts are written onto their demo leaf, not matched (amends ADR-087)

## Status

Accepted (HF-3).

## Context

"Add demo campaign data" (`POST /workspaces/:ws/demo-data/campaigns`, ADR-087) failed with
"Internal error" on the production Sandbox: a workspace seeded with the old monthly demo facts plus
one real budget, "Brand", under a demo budget. ADR-087 wrote a fiscal year of daily campaign facts
(~20–28k spend and KPI rows) with the ingest upsert, flagged them `demo` with two more full
updates, and ran `matchRunFacts` over them — all in one interactive transaction. On a local
Postgres with the Sandbox's shape that took 11–12 s, 8 s of it in the matcher (EX-1/EX-5's
reference, rule, convention and tuple levels plus the ancestor-chain search for every fact). On
production's `db-g1-small` that multiplies, and the transaction does not finish.

The matcher was also the wrong tool for demo data: "Brand" has the leaf's tuple and sits under it,
so it is the deepest candidate on the chain and the matcher put every new demo fact on the real
budget. And ADR-087 decision 5 superseded only old demo facts still on a demo leaf, so an old fact
that a re-match had moved onto "Brand" stayed live beside the new campaign facts.

## Decision

1. Every demo fact is generated for exactly one demo leaf and is written onto it directly —
   `envelope_id` = that leaf, `match_method = 'tuple'`, `demo = true` — in one multi-row INSERT per
   fact table (`insertDemoFacts`, `packages/db/src/demo.ts`). No upsert, no `UPDATE … SET demo`, no
   `matchRunFacts`. Both `seedDemoData` and `reseedCampaignDemoData` use it. The leaf's tuple is a
   subset of the fact's, so `tuple` is the method the matcher would have recorded on a workspace
   with no real budgets.
2. ADR-087 decision 5 is narrowed to its intent: the reseed supersedes every live demo fact of the
   workspace without a `campaign` key, whichever envelope it sits on.
3. The transaction timeout stays 60 s; the work is now about 1 s locally on the same dataset.

## Consequences

- Demo money never lands on a real budget. A real fact still matches through the normal ingest path.
- A later re-match (an envelope edit, a match rule) may still move demo facts, as before; purge
  deletes demo facts wherever they are (ADR-087, W1-4).
