# ADR-020: Web shell, sign-in token, route files and design tokens

## Status

Accepted.

## Context

T-026 (spec §18.1) adds the SPA shell, router, generated API client and design-token hookup. The done-when: navigate every route with auth. Four things were open:
- how the browser gets a token before Identity Platform sign-in is connected (the GCP phase);
- how §18.1's parent-and-child file names nest in TanStack Router;
- what tokens to use while the design-team file is absent;
- how Playwright gets a browser on a laptop.

## Decision

- **Token source (`apps/web/src/lib/auth.ts`):** the Identity Platform ID token is kept in `sessionStorage` for the tab. It's a credential, not app data, so the no-`localStorage`-for-data rule is untouched.
  - Until Google Workspace sign-in is wired (GCP phase), the sign-in screen takes a pasted token.
  - The API verifies every request as always; there is **no auth bypass** anywhere.
  - A 401 clears the token. A token change clears TanStack Query and re-runs the route loaders.
  - With no token, loaders don't call the API.
- **Local and e2e auth:** Playwright and `pnpm --filter @budget/web e2e:stack` start a local JWKS, point the real API at it (`AUTH_JWKS_URL`), seed a golden workspace through the real commands, and sign Identity Platform shaped tokens for golden personas (LOCAL_BUILD_PHASES finding 9).
- **Routes:** the §18.1 flat file names. A route with children (`approvals`, `experiments`, `sources`) is an `<Outlet/>` parent with an `index` page, because in TanStack Router `w.$ws.approvals.$id.tsx` nests under `w.$ws.approvals.tsx`. Screens that later tasks build show the task that brings them. `w.$ws.budgets.tsx` carries the spec's `ExplorerSearch` exactly.
- **API client:** `openapi-typescript` generates `src/lib/api.gen.ts` from `apps/api/openapi.json` (`pnpm --filter @budget/web api:generate`). `src/lib/api.ts` is the `openapi-fetch` client with the bearer middleware. `api.gen.test.ts` fails when the generated file is stale.
- **Design tokens:** the design team's token file is not in the repo. `packages/ui/src/tokens.css` holds the **shadcn defaults** (neutral base, Tailwind v4) and nothing else; no visual language is invented. Components read only the token names, so the design-team file replaces this one. (The Stitch direction shared in chat has its own open questions: which source wins, and its fonts are OFL-1.1, outside the licence allowlist.)
- **`@budget/ui`:** `cn`, `Button`, i18n `t()`. A disabled `Button` requires `reason` at the type level and shows it as a tooltip; the JSX eslint rule is T-040. Every tour target in the shell has `data-tour`.
- **Playwright:** uses the installed Google Chrome (`channel: "chrome"`), so no browser download is needed; `PW_CHANNEL=` switches to Playwright's Chromium. CI still runs lint and typecheck only.
- **API start:** `apps/api/src/main.ts` starts the server when run directly (`pnpm --filter @budget/api dev`), which Playwright needs.

## Consequences

- Blocked: the design-team token file; Identity Platform sign-in in the browser (GCP phase).
- The Explorer's `filter` search param is JSON for now. lz-string (`src/lib/filters.ts`, tested) is wired into the router with the filter bar (T-027).
