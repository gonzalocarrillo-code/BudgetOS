# Web app (T-026, ADR-020)

## Run it against a seeded workspace

```
pnpm --filter @budget/web e2e:stack
```

This starts the local JWKS (:4899), the API (:3199) and Vite (http://127.0.0.1:5199), and seeds a golden workspace. It prints an admin token to paste into the sign-in screen. Ctrl-C stops everything and removes the workspace.

## End-to-end tests

```
pnpm test:e2e
```

Playwright uses your installed Google Chrome. With `PW_CHANNEL=` it uses Playwright's Chromium instead (`npx playwright install chromium` first).

## After an API change

Run `pnpm --filter @budget/web api:generate`; `src/lib/api.gen.test.ts` fails until you do. For new route files, run `pnpm --filter @budget/web routes:generate` (Vite also regenerates `src/routeTree.gen.ts` in dev).
