# @budget/web — React 19 SPA

The frontend application built with Vite and TanStack Router. Implements spec §18 (web routes, Explorer grid, filter bar, search UI).

## Running tests

```bash
pnpm --filter @budget/web test              # unit tests (e2e requires `pnpm dev`)
pnpm --filter @budget/web test:e2e          # Playwright e2e against a running dev server
```

## Architecture

- `src/lib/` — hooks (useQuery, usePermissions, useData)
- `src/routes/` — TanStack Router file structure (one file per route)
- `src/components/` — reusable UI components from `@budget/ui`
- `src/modules/` — feature modules (Explorer, Budgets, Approvals, Settings, Home, etc.)

Filter/grouping/sorting state lives in URL search params; server-side `/query` returns totals and filtered rows. No `useEffect` for fetching; no client-side aggregation.
