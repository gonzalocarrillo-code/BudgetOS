#!/usr/bin/env node
// Licence gate (AGENTS.md §3/§4): every production dependency of every
// workspace package, direct or transitive, must carry an allowlisted licence.
// A package outside the allowlist passes only if scripts/license-exceptions.json
// names its exact name, version and licence (ADR-004). Exits non-zero on a
// disallowed licence, a stale exception, an unparseable report, or a report
// that is empty or misses a declared dependency.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ALLOW = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'CC0-1.0', 'Unlicense']);
const root = new URL('..', import.meta.url).pathname;

function fail(message) {
  process.stderr.write(`license-check: ${message}\n`);
  process.exit(1);
}

// SPDX expression: allowed if any OR-branch has every AND-term allowlisted.
function isAllowed(expr) {
  const bare = expr.trim().replace(/^\((.*)\)$/, '$1');
  return bare.split(/\s+OR\s+/).some((branch) =>
    branch.split(/\s+AND\s+/).every((term) => ALLOW.has(term.trim().replace(/^\(|\)$/g, ''))),
  );
}

// Declared direct production deps (excluding workspace links) across apps/* and packages/*.
const declared = new Set();
for (const group of ['apps', 'packages']) {
  for (const dir of readdirSync(join(root, group))) {
    const manifest = join(root, group, dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const deps = JSON.parse(readFileSync(manifest, 'utf8')).dependencies ?? {};
    for (const [name, range] of Object.entries(deps)) {
      if (!String(range).startsWith('workspace:')) declared.add(name);
    }
  }
}

const raw = execFileSync('pnpm', ['-r', 'licenses', 'list', '--prod', '--json'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});

let report;
try {
  report = JSON.parse(raw);
} catch {
  fail(`could not parse \`pnpm licenses list\` output:\n${raw.trim()}`);
}

const exceptions = JSON.parse(readFileSync(join(root, 'scripts/license-exceptions.json'), 'utf8'));
const exceptionKey = (name, version, license) => `${name}@${version} ${license}`;
const unused = new Map(exceptions.map((e) => [exceptionKey(e.package, e.version, e.license), e]));

const found = new Set();
const violations = [];
for (const [license, pkgs] of Object.entries(report)) {
  for (const pkg of pkgs) {
    found.add(pkg.name);
    if (isAllowed(license)) continue;
    for (const version of pkg.versions) {
      const key = exceptionKey(pkg.name, version, license);
      if (!unused.delete(key)) violations.push(`  ${key}`);
    }
  }
}

if (found.size === 0 && declared.size > 0) fail('no packages found in the licence report');
const missing = [...declared].filter((name) => !found.has(name));
if (missing.length > 0) fail(`declared dependencies missing from the licence report: ${missing.join(', ')}`);

if (violations.length > 0) {
  fail(`${violations.length} production dependencies outside ${[...ALLOW].join(';')} and not in scripts/license-exceptions.json:\n${violations.sort().join('\n')}\nRun \`pnpm -r why <name> --prod\` to find the importer.`);
}
if (unused.size > 0) {
  fail(`stale entries in scripts/license-exceptions.json (not in the production tree; remove or re-review):\n${[...unused.keys()].map((k) => `  ${k}`).join('\n')}`);
}

process.stdout.write(`license-check: ${found.size} production dependencies, all allowlisted (${exceptions.length} reviewed exceptions)\n`);
