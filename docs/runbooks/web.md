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

## Explorer (T-027, ADR-022)

`/w/<ws>/budgets` runs every view through `POST /api/v1/workspaces/<ws>/query` with the live-leaf filter. Tree totals and pivot totals are the same API totals. If they differ, a query dropped `LIVE_LEAVES`.
- A blank grid with a row count in the footer means the canvas didn't redraw. Check the `@budget/grid` row-cache version dependency.
- Edits that do nothing usually mean Glide's `#portal` div is missing from `index.html`.

## Content Security Policy (ADR-075)

The API serves the CSP (`apps/api/src/configure-app.ts`'s `CSP_DIRECTIVES`), not the web app, so a new asset host or inline script shows up as a *browser* CSP violation (console + a blocked network request), not a build error. Before adding one:
- **A new script**: put it in `apps/web/public/` and reference it with `<script src="/…">` (same-origin, covered by `script-src 'self'`) instead of inlining it or reaching for `'unsafe-inline'`/a hash. `index.html`'s pre-paint theme read lives at `public/theme-init.js` for exactly this reason.
- **A new stylesheet host or font** (e.g. Google Fonts): add the host to `styleSrc`/`fontSrc` in `CSP_DIRECTIVES`, with a comment saying why, rather than widening `'unsafe-inline'` further.
- **A new image/asset host**: add it to `imgSrc`. Uploaded SVG icons and asset previews already use `data:`/`blob:`, covered.
- **A new API/websocket host the SPA calls directly**: add it to `connectSrc`. Everything today goes through the same origin (`'self'`).
- Check the browser console after any such change; a CSP violation there does not fail `pnpm dev` or `pnpm test`.
