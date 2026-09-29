# ADR-055: Mapping profiles, synonyms and the mapping preview

## Status

Accepted (product feedback round 8, docs/DATA_PLAN.md §2, tasks D-004 to D-006).

## Context

Every client names its columns differently, and one client's CPA is another's tCPA. The column mapping (spec §14) and the org's metric library already handle any naming, but each source was mapped from scratch, the wizard guessed only by fixed patterns, and a mapping's problems showed up only after a run rejected rows.

## Decision

- **Mapping profiles** (`mapping_profile`, workspace-scoped with RLS). A profile is a named mapping with the header it was made from. A file whose header matches a profile, in any case or order, maps from it (`exact`), or from the profile whose columns it contains (`covers`, the rest guessed). A source can follow a profile: it takes the profile's mapping and parse pattern, and a change to the profile rewrites every follower in the same transaction, each with its own `source.updated` audit row. A mapping of the source's own ends the link. Archived profiles match nothing and cannot be followed.
- **Synonyms** (`mapping_synonym`). Column synonyms say what a header means (a dimension, or a role with a KPI metric); metric synonyms say which metric a word names (tcpa → cpa). A built-in list ships in `@budget/domain`, so every workspace starts with it; the workspace's own rows come first and can switch a built-in word off. Every mapping saved teaches its columns as `learned` rows, which follow the latest mapping and count their uses; a `manual` row is never overwritten by what is learned. The wizard's guesser and the AI prompt both read them.
- **Ratios are recognised, not ingested.** A word that names a metric with a denominator (CPA, ROAS, CTR, and each workspace's synonyms for them) is a ratio. The guesser leaves such a column out, the AI prompt is told to, and the preview explains why: BudgetOS computes ratios from counts at every level of the tree, and a summed ratio is wrong.
- **The mapping preview** (`POST /workspaces/:ws/mapping-preview`) runs a sample through the same registry index and normalizer the ingest pipeline uses, so what it says is what a run will do: what each column becomes, each dimension value's code, unknown values with the nearest code by code, label or alias, ratios, KPIs no metric reads yet, and the rows a run would reject with the pipeline's own reason. It writes nothing.
- One audit event and one outbox row per profile or synonym write. The workspace purge and the golden cleanup delete both tables.

## Consequences

- A client that sends the same export every week maps it once.
- A tCPA column is left out, not stored as a KPI. If a client can only send ratios, a non-additive leaf-only metric remains the plan's answer (§2.2) and is not built here.
