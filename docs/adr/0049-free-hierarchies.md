# ADR-049: Hierarchies are free, and a missing granularity is not a tree level

## Status

Accepted. This amends spec §8 (hierarchy template validation) and §18.2 (the Explorer tree).

## Context

Product feedback (2026-09-28), from a new workspace:

- "It doesn't let me be completely free because it says x nests under y. I want to have Client, Fiscal Year, Region, etc. freely."
- "I added FY2026 Media, that should be on top of everything. Client doesn't need to show up in budgets unless described in granularities."

Two things got in the way:

- **Template ordering.** A hierarchy template refused any order that broke a dimension's `allowedParents`. For example, Region was only allowed under Client.
- **Empty groups.** The Budgets tree showed a "No <granularity>" group for every level a budget leaves empty. A budget with no granularities therefore sat six empty groups deep, under the account's name.

## Decision

- **Any order.** A template's levels may come in any order. Each level must be an active dimension and appear only once. `allowedParents` now governs only *values* (a country value under a region value). The registry calls it "Values nest under".
- **Empty groups fold away.** In the Budgets tree, a group with no value for its level is not a row. Its contents sit one level up, ahead of the valued groups. The fold is recursive, so:
  - a budget with no granularities is at the top of the tree;
  - a workspace that never sets a client shows no Client level.

  Only rows move; every number still comes from the server (`/tree` or `/query`). Node keys keep their real paths (`∅/EMEA`), so the expanded state in the URL still works.
- **Unchanged:** the pivot still shows "No <granularity>" groups, because there the missing value is the answer.

## Consequences

- A folded group costs one extra request per level on first load. At most one per template level, and they're sequential.
- The account-named root group (product feedback 2) is gone from the tree. The budgets it held are listed at the top instead.
