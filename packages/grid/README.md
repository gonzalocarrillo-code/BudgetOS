# @budget/grid

Rendering engine: @glideapps/glide-data-grid

T-026a measured Glide Data Grid 6.0.3 against a TanStack-only grid (`@tanstack/react-table` 8.21.3 and `@tanstack/react-virtual` 3.14.13) on 100,000 in-memory rows by 12 columns. Both scrolled at 59.9 fps p50 in headless Chrome. Glide's visible-window sample was 5.217 ms against 61.591 ms for TanStack, and Glide does not build a row object for every row. The numbers and the decision are in `docs/adr/0002-grid-core.md`.

`BudgetGrid` (server-side row model, budget cells, editors, paste) is T-026c. The database golden at 100,000 leaves is T-034.
