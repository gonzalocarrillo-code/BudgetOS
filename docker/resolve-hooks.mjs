// Node module customization hook for the production image (W2-8, audit S-10/M-6).
//
// Every `@budget/*` package.json still points its "exports" at TypeScript source
// (e.g. "./src/index.ts"), unchanged, so `pnpm dev`/`tsx`/`vitest` keep working exactly as
// before. The Docker build compiles each package's `src/` (and `packages/db`'s `seed/`) to
// plain JavaScript IN PLACE, next to the `.ts` files (see docker/build-server.sh), rather than
// into a separate `dist/` directory — the two layouts can therefore never drift apart and no
// cross-package rootDir bookkeeping is needed.
//
// This hook runs only in the runtime image (registered via NODE_OPTIONS, see
// docker/register-hooks.mjs) and rewrites any resolution that lands on a `.ts` file to its
// compiled `.js` sibling. It never reads or type-checks anything; it only edits the resolved
// URL, so it is a few lines long and has no dependency on which package or subpath was asked
// for.
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (result.url.startsWith("file:") && result.url.endsWith(".ts")) {
    return { url: result.url.slice(0, -3) + ".js", shortCircuit: true };
  }
  return result;
}
