# ADR-023: Global search palette

## Status

Accepted.

## Context

T-028 (spec §18.4, plan §11.3) adds the search UI over T-020's `/search` and `/search/suggest`. The done-when is qualifier autocomplete, in Playwright.

## Decision

- **Opening it:** one palette (cmdk, MIT), opened with ⌘K / Ctrl+K, `/` (outside inputs), or the header search field, which is now a button that opens the palette.
- **Autocomplete:** the last token is what gets completed.
  - Two or more letters (or `key:`) ask `/search/suggest` for qualifier keys: the fixed set plus every registry dimension, read live, so custom dimensions such as `retailer` are there at once.
  - After `key:`, it asks for that key's values.
  - Picking a key leaves the caret after the colon; picking a value ends the token with a space. Values with spaces are quoted. A leading `-` (negation) is kept.
- **Searching while typing:** a qualifier key still being typed is not searched. "brazil reg" searches "brazil" while `reg` completes to `region:`, so results don't go blank mid-word. A `key:value` token is searched as typed.
- **Chips and results:**
  - completed qualifiers show as chips (from `parseSearch`);
  - results are grouped by type, top 5 per group, with the group count and "See all N in …", which opens `/w/$ws/search?q&type` with up to 50 per type;
  - a hit opens its API deep link, for example `budgets?select=<id>`, which opens the Explorer drawer;
  - "All results" opens the results page.
- **⇧Enter** opens the Explorer filtered by the search's dimension qualifiers (eq / neq). Other qualifiers have no Explorer equivalent yet.
- **Enter** opens the highlighted item (cmdk highlights the first).
- **Recents and pins are not built.** They need per-user storage, which AGENTS §4 keeps out of `localStorage`; they come with a user-preferences row.

## Consequences

- The results page is a list; result rows show title, path and status. Amount and pace facets are in the API response but not displayed yet.
