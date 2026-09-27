# ADR-036: Settings in global search

## Status

Accepted.

## Context

T-041 (spec §12 and §22, plan §11.7) indexes admin pages and their options into `search_document`, so that typing a setting's name in ⌘K opens the right admin page. The spec does not say:

- where the list of settings lives;
- how an option on a tab is linked;
- how a setting wins the Enter key over budgets and alerts that share a word;
- which roles see settings.

## Decision

- **Catalog in code.** `SETTINGS` in `@budget/domain/settings.ts` lists each admin page and the options people look for on it. Each entry has a fixed id, a title, a section, a path and keywords. Settings are product structure, not tenant data, so they are not registry rows. Fixed ids mean a re-index updates the same documents.
- **Indexed per workspace.** Each workspace gets one `search_document` per entry, with `entity_type = 'setting'`:
  - title = the setting's title;
  - path = `Settings › <section>`;
  - body = the keywords.
  `buildSettings` runs in the full re-index (so the golden seed has them) and on `workspace.created`. The type is workspace-wide, like tags and registry values: no dimension scope applies.
- **Deep link** is `/w/:ws` + the entry's path, including the page's own search params in TanStack's JSON encoding (for example `?tab="metrics"` or `?kind="match_key"`). The page opens on the right tab.
- **Ordering.** The settings group comes last, unless one of its titles starts with the typed text. Then it comes first, so Enter opens that page.
- **Visible to every role**, as the admin nav is. Each page's own permission checks still apply.

## Consequences

- **Palette fixes found on the way:**
  - The last word was always treated as a qualifier key being typed, so a single word ("snowflake") was never searched. Now it is treated as a key only when `/search/suggest` returns keys for it.
  - A new result set now highlights its first hit, so Enter after typing opens the best match, not "All results".
- **Upkeep:** a new admin page or option needs a `SETTINGS` entry. Workspaces indexed before this change get settings on their next re-index (runbook `search.md`).
