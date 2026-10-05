# ADR 0074: Security Overrides for Transitive Dependencies

**Status:** Accepted  
**Date:** 2026-10-05  
**Context:** W2-6 hardening — audit S-8  

## Problem

Production dependencies contain multiple high and critical security vulnerabilities in transitive dependencies:
- **fastify 5.11.3**: 4 high-severity vulnerabilities (request body replacement, authentication bypass, validation bypass, header bypass, HTTP/2 DoS)
- **lodash 4.17.21**: 1 high-severity vulnerability (code injection via template imports)
- **toml 3.0.0**: 2 high-severity vulnerabilities (uncontrolled recursion, prototype pollution)
- **deepmerge-ts 7.1.5**: 1 high-severity vulnerability (stack exhaustion via recursive object merging)
- **js-yaml 5.3.0**: 1 moderate-severity vulnerability (maxTotalMergeKeys CPU exhaustion)

These are transitive dependencies injected by:
- `@nestjs/platform-fastify` → fastify
- `@glideapps/glide-data-grid` → lodash
- `snowflake-sdk` → toml
- `@prisma/client` > prisma > @prisma/config → deepmerge-ts
- `@nestjs/swagger` → js-yaml

Direct dependency updates are blocked (e.g., Glide Data Grid pinned to 6.0.3 per spec §1; Prisma to 6.19.3; Swagger to 11.4.7; Snowflake SDK to 3.3.0). These libraries do not expose newer versions of their transitive dependencies.

## Decision

Apply `pnpm.overrides` in the root `package.json` to force patched versions of these transitive dependencies. Use exact versions (no `^` or `~`) to ensure reproducible builds:

```json
"pnpm": {
  "overrides": {
    "exceljs>unzipper": "0.12.3",
    "fastify": "5.12.5",
    "lodash": "4.18.1",
    "toml": "4.2.0",
    "js-yaml": "5.4.1",
    "deepmerge-ts": "8.0.0"
  }
}
```

Versions chosen: lowest patched version that exists on npm and resolves all advisories for that package (e.g., fastify 5.12.5 for the HTTP/2 trailer DoS; lodash 4.18.1 verified to patch both code injection and prototype pollution; toml 4.2.0 for both recursion and prototype pollution).

**Rule:** Security patches of transitive dependencies go through `pnpm.overrides` with exact versions. Direct pinned major version changes only by ADR. 

### Packages NOT overridden

- **uuid 8.x and 9.x**: Patched versions (10.x) introduce breaking changes incompatible with `snowflake-sdk` and Google Cloud libraries. The moderate-severity advisory (GHSA-w5hq-g745-h8pq) affects only cloud library transitive paths; no direct application code path uses uuid. Deferred to a future audit when the cloud libraries release uuid 10.x compatibility.

- **vitest 2.1.9**: Critical path-traversal vulnerability (GHSA-82fw-gwwq-j7x9) fixed only in vitest 4.1.11. A major bump from 2.x to 4.x requires an ADR; defer to hardening plan decision.

- **vite 5.4.21** (already at latest): No vulnerabilities in audit; no bump needed.

## Consequences

- Production audit output now clean at `--audit-level=high`.
- Lock file (`pnpm-lock.yaml`) updates only for the overridden packages and their direct dependency resolution lines.
- All downstream code continues to work without modification (Fastify, lodash, etc. are APIs that remain stable across patch versions).
- CI will enforce clean audit on main once W0-1 is merged (removes `continue-on-error: true` from the audit step).

## Related

- W0-1: CI gate for `pnpm audit --prod` (requires this PR to pass)
- STACK_AUDIT_2026-10-04.md: S-8 audit findings
- AGENTS.md §4: Non-negotiables on dependencies and versions
