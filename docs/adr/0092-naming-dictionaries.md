# ADR-091: Campaign naming — built-in dictionaries, name analysis, optional AI, defined in Registry

## Status

Accepted (EX-6). Extends ADR-0090.

## Context

EX-5 (ADR-0090) added the naming convention: a delimiter and, per position of a campaign name, a
dimension key and a few aliases (`FB` → `meta`). A part resolved only against the dimension's
registry values, so a convention knew positions but not definitions: a position of countries
or languages needed every value typed into the registry first. The owner asked for a fast way to
analyze campaign nomenclature, dictionaries like the default granularities ("I don't want to
manually list all countries again, or all languages, or regions"), AI only as support, and then
("maybe in granularities, we can add the campaign separator? so they are both connected") the
convention defined where the granularities are.

## Decision

1. **Built-in dictionaries** live in `@budget/domain` (`naming-dictionaries.ts`): countries
   (ISO 3166-1 alpha-2 and alpha-3, English / Spanish / Portuguese names and abbreviations such
   as UK → GB, EEUU → US), languages (ISO 639-1, three-letter codes, English / native / Spanish /
   Portuguese names: ES, ESP, Spanish, Español → `es`), regions (LATAM, EMEA, NA → AMER, APAC, EU,
   MENA, DACH, GLOBAL…), platforms (FB / IG / Facebook / Instagram → `meta`; GG / GADS / AdWords /
   YT / YouTube → `google_ads`; DV360; TT → `tiktok`; Snap; LI; X / Twitter; Pinterest; Amazon;
   Programmatic…), channels, objectives, audiences (remarketing → `retargeting`), funnel stages,
   devices, months (en / es / pt), quarters and years (patterns). Static tables plus the runtime's
   `Intl.DisplayNames` for the names in each language; **no dependency**. Canonical codes are the
   default registry's codes (`GB`, `meta`, `google_ads`, `LATAM`…). Tokens compare case-, accent-
   and punctuation-insensitively.
2. **A dimension uses the dictionary of its kind automatically**, from its key: the default
   granularities (`country`, `region`, `platform`, `channel`, `objective`, `audience`,
   `funnel_stage`) and common synonyms (`market` → country, `lang` → language). Nothing is stored
   for this; it is a function of the key (`dictionaryKindFor`).
3. **Resolution order** of a convention part: the position's alias (the workspace's explicit
   override) > the dimension's registry values (code, value alias, label) > the dictionary
   (landing on the registry value whose code, label or alias is any synonym of the entry, so a
   registry that says `UK` keeps `UK`; else on the canonical code) > unresolved. Matching
   (`conventionTuples`) and the preview use the same reader (`explainCampaignName`).
4. **Registry values are created from a dictionary on demand** (rows, not columns): saving the
   convention (or adding an alias) reads every live campaign name and inserts the values only a
   dictionary knows into the workspace's dimension of that key, else the org-wide one
   (`ON CONFLICT DO NOTHING`: an existing value is never changed). They are listed in the write's
   audit row.
5. **The convention is defined in Registry › Campaign names**, next to the granularities: one
   separator for the workspace, the number of parts, and per position a granularity (with its
   dictionary shown, never typed) and its aliases. Storage stays EX-5's `naming_convention` table;
   no migration. **One convention per workspace** is edited: `PUT /workspaces/:ws/naming-convention`
   soft-deletes the live rows and writes a new one (never updated in place). EX-5 allowed several
   and matching still tries every live one, oldest first; the Registry edits the newest and says
   how many older ones still apply. `POST /naming-conventions` and `DELETE /naming-conventions/:id`
   stay for compatibility. The Spend data page's Rules section shows the convention read-only
   (separator, position → granularity, preview, unresolved tokens) with a link to Registry.
6. **Unresolved tokens** are listed per position with the number of campaigns and their live spend
   (the preview, over every live campaign). "Map to…" is `POST /workspaces/:ws/naming-convention/aliases`
   `{dimension, token, value}`: the value must resolve (registry or dictionary) and is stored as the
   position's alias in a new version of the convention.
7. **Analyze names** (`POST /workspaces/:ws/naming-conventions/analyze`, deterministic): pasted
   names or the workspace's campaign names (largest spend first, up to 1000) → the delimiter that
   splits most names into the same number of parts, per position its cardinality, examples and the
   share of names each dictionary (through the workspace's dimension of that kind, or a registry's
   own values) reads, and a proposal (best hit rate ≥ 50%, each dimension once). Nothing is saved.
8. **Suggest with AI** (`POST /workspaces/:ws/naming-conventions/suggest`) calls `@budget/ai` only
   (OpenAI, the deployment's existing `OPENAI_API_KEY` / `OPENAI_MODEL`, as the source mapping
   suggestions do; 503 without it, and the button says why). It sends only distinct campaign names
   (at most 300) and the dimension keys with their dictionary kind: no amounts, no ids. The answer is
   validated with zod (shape, known dimensions, each once, mappings at named positions) and returned
   as a suggestion and a proposal with aliases; nothing is applied. The request is audited
   (`naming_convention.ai_suggested`: who, how many names, model; no names or prompt) with one
   `source.changed` outbox row (a topic with no consumer besides search, which ignores it).
9. **Permissions.** Writes, analysis and AI need `source.manage` (as in ADR-0090: a convention moves
   spend across budgets); reading the convention needs `envelope.read`. Every write re-matches the
   campaign facts in its transaction and emits one `audit_event` (`naming_convention.saved`,
   `naming_convention.alias_added`) and one `facts.loaded` outbox row.

## Consequences

- Tokens that EX-5 left unknown now resolve when a dictionary reads them: a name can start fitting
  a convention (a fact may move to a deeper budget). A name that still fits nothing keeps its plain
  tuple match, as in ADR-0090.
- Registry label matching is new: a token equal to a value's label (normalized) resolves to it.
- Dictionary names depend on the runtime's ICU data (Node 22 and current browsers ship full ICU);
  codes and the static synonyms do not.
- A dimension whose key is not a known kind has no dictionary; the analysis still proposes it from
  its registry values. Mapping arbitrary keys to a kind (a registry row) can come later if needed.
- Several live conventions (EX-5) still work; the Registry shows the newest and counts the rest.
