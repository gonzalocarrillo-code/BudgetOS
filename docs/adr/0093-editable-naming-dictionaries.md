# ADR-0093: Campaign-naming dictionaries are data — built-in seed, editor, position kinds, AI fill

## Status

Accepted (EX-7). Amends ADR-0092 (decisions 1, 2, 3, 5, 6 and 8); extends ADR-0090.

## Context

EX-6 (ADR-0092) read campaign-name tokens through built-in dictionaries that lived in code
(`@budget/domain` `naming-dictionaries.ts`, "shown, never typed") plus a free-text alias box per
position. The owner could not find or change them ("where does the dictionary actually live? …
I want to freely edit this … an extensive dictionary and editable, as well with AI"). Real names
have 16 parts, many client codes no built-in list knows (GNB, GCP, YTB, BAU, ACQ, PER, MIX…), a
`MMDDYY` launch date, free text at the end, and hyphens inside parts (`Core-Translate`).

## Decision

1. **Dictionaries are rows.** `naming_dictionary` (one per workspace and granularity key: the
   built-in kind it was seeded from, `seeded_at`, a nullable `sync_source_id`) and
   `naming_dictionary_entry` (code as written, `code_norm` = `normalizeToken(code)`, `value` = the
   registry value code it means, `label` = meaning, `notes`, `source` ∈ builtin | user | ai | sync,
   nullable `sync_source_id`, `created_by`, soft delete). One live entry per normalized code; an
   edit soft-deletes the old row and inserts a new one. Tenant tables with RLS, read by `budget_mcp`,
   in the purge list.
2. **Built-in lists are the seed.** `naming-dictionaries.ts` stays the source; `builtinDictionaryRows`
   turns a kind into rows (every code and synonym once → canonical code). They are copied into a
   workspace the first time a granularity is used in a saved convention (once; a deleted built-in
   entry stays deleted). Until then the static dictionary is read as in EX-6. "Reset to built-in"
   soft-deletes every live entry except synced ones and copies the seed again. Quarter and year stay
   patterns (not seeded).
3. **Resolution order** of a granularity position: the position's EX-6 alias (still read) > the
   workspace dictionary's own entries (user, ai, sync — explicit overrides, landing on the registry
   value with that code, else created on demand) > the registry's values (code, alias, label) > the
   built-in entries (seeded rows, else the static dictionary; landing on the registry value that
   matches any synonym, as in EX-6) > unresolved. EX-5/EX-6 matching precedence and fallback are
   unchanged.
4. **Position kinds** (`NamingConventionToken.kind`, optional for EX-6 rows): `dimension`,
   `ignore` (anything, even empty; never makes a name non-conforming), `date` (`datePattern`
   MMDDYY / DDMMYY / YYYYMMDD / YYMMDD; a part that is not a real date is a `date` problem) and
   `free_text`. Date and free-text values are attributes (`launch_date` and `position_<n>` by
   default, or the position's `attribute`) returned with every explained name and preview row;
   they are derived from the name when read, not stored per campaign. Names are split on the chosen
   separator only. The campaign granularity is never a position or a dictionary (EX-9 makes it
   data-derived).
5. **EX-6 aliases migrate expand-safely.** They stay in `naming_convention.tokens` and are still
   read. Every dictionary write and every convention save first copies the live conventions'
   aliases into entries (source `user`, notes "EX-6 alias") where the code has no entry yet; the
   editor lists not-yet-copied aliases read-only. No SQL data migration: under FORCE RLS the
   production owner (no BYPASSRLS) would see no rows. The Registry UI no longer types aliases; the
   EX-6 alias endpoint stays for compatibility.
6. **Editor**: Registry › Campaign names › Dictionaries (URL `view=dictionaries&dict=&dq=`): pick a
   granularity, server-side search, inline add / edit / delete, bulk paste (`code<TAB>meaning[<TAB>value]`),
   CSV import / export (`code,meaning,value,notes,source`), reset, AI fill. Synced entries are
   read-only with a reason (EX-8 will sync a Sheet or Snowflake into the same table; your entries
   win on conflict). Each position row links to "Edit dictionary"; a new granularity can be created
   inline (`registry.manage`, as in Registry). Unresolved codes are listed per position with count
   and spend and a "Define" action that adds an entry.
7. **AI (support only, `@budget/ai`, the deployment's OpenAI)**: "Analyze names with AI" (EX-6's
   suggest) now proposes per position a role (granularity, ignore, date with pattern, free text) and
   a new granularity's name; nothing is created or applied. "Fill dictionary with AI" sends a
   position's unresolved codes (≤ 200), example names carrying them (≤ 10), the granularity's name
   and its registry values (≤ 200; codes and labels); never amounts or ids. The answer is zod
   validated and narrowed to the codes sent and values that exist; the user checks rows and only
   those are written (`bulk`, source `ai`). Audited (`naming_dictionary.ai_suggested`: counts and
   model only). 503 / disabled with a reason without OpenAI.
8. **Writes**: `source.manage`; reads: `envelope.read`. Every write: one `audit_event`
   (`naming_dictionary.entry_added | entry_updated | entry_deleted | bulk_written | reset`) and one
   outbox row — `facts.loaded` when the newest convention reads that granularity (registry values
   created on demand, campaign facts re-matched in the same transaction), else `source.changed`.

## Consequences

- A token that a built-in list mis-reads can now be fixed by the workspace (delete or edit the
  entry); a client code list is just a dictionary without a built-in seed.
- Seeding copies about 1,040 rows for countries and 710 for languages (under 100 for the other kinds) per workspace, once.
- Attributes (launch date, free text) are not persisted per campaign; EX-9 (campaign as a
  data-derived granularity) is the place to surface them.
- A rollback to EX-6 code after EX-7 has saved a convention with `kind` fields would fail EX-6's
  strict token parsing; forward-only, like any schema-bearing jsonb change.
- `dimension_key` is a key, not an FK: dictionaries follow granularities by key across the org-wide
  and the workspace's own dimension, like conventions do.
