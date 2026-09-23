# @budget/grid

Rendering engine: @glideapps/glide-data-grid

T-026a measured Glide Data Grid 6.0.3 against a TanStack-only grid (`@tanstack/react-table` 8.21.3 and `@tanstack/react-virtual` 3.14.13) on 100,000 in-memory rows by 12 columns. Both scrolled at 59.9 fps p50 in headless Chrome. Glide's visible-window sample was 5.217 ms against 61.591 ms for TanStack, and Glide does not build a row object for every row. The numbers and the decision are in `docs/adr/0002-grid-core.md`.

`BudgetGrid` is the server-side row model: a 200-row page cache, path / money / pace / target / status / chips renderers, money, percent, date, dimension, tag, and text editors, paste forwarded to `onPaste`, and pinned totals. Stories for every cell kind live in `src/cells.stories.tsx`. Headless Chrome scrolled that grid at 59.9 fps p50 on 100,000 in-memory rows by 12 columns (`budgetGridScrollFpsP50` in `bench/baseline.json`). `getCellContent` was 0.005 ms p95 and first paint was 35 ms. The database golden at 100,000 leaves is T-034. Plan epic 0.7 still says 60 fps.
