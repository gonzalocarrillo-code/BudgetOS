import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const expectedScripts = {
  dev: "turbo run dev --parallel",
  // The persistent localhost stack (docs/runbooks/local.md).
  "dev:local": "pnpm --filter @budget/web local",
  build: "turbo run build",
  lint: "turbo run lint",
  typecheck: "turbo run typecheck",
  test: "turbo run test",
  "test:acceptance": "turbo run test:acceptance",
  "test:e2e": "pnpm --filter @budget/web test:e2e",
  "db:migrate": "pnpm --filter @budget/db prisma migrate deploy",
  "db:seed": "pnpm --filter @budget/db tsx seed/golden.ts",
  "db:reset": "./scripts/dev-reset.sh",
  // The Slack app manifest for an API URL (docs/runbooks/slack.md).
  "slack:manifest": "pnpm --silent --filter @budget/api slack:manifest",
  // ADR 0004: license-checker-rseidelsohn saw no pnpm workspace dependencies.
  "license-check": "node scripts/license-check.mjs",
  bench: "turbo run bench",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

it("pins the spec §2 scripts", () => {
  const parsed = readJson(join(root, "package.json"));
  expect(isRecord(parsed) ? parsed["scripts"] : undefined).toEqual(expectedScripts);
});

it("copies the spec §2 compose file, plus the GCS emulator from ADR-011 and the owner-role init script from W0-6", () => {
  const compose = readFileSync(join(root, "docker-compose.yml"), "utf8");
  expect(compose).toBe(`services:
  db:
    image: postgres:16
    environment: { POSTGRES_USER: budget, POSTGRES_PASSWORD: budget, POSTGRES_DB: budget }
    ports: ["5432:5432"]
    # W0-6 (docs/STACK_AUDIT_2026-10-04.md S-2, S-3, S-21): runs once, automatically, the first
    # time this container's data directory is created. Creates \`budget_owner\`, the non-superuser,
    # NOBYPASSRLS role that migrations/seed/tests run as from here on, matching production's
    # owner. An existing local volume does not re-run this — \`pnpm db:reset\` recreates it
    # (docs/runbooks/local.md).
    volumes:
      - ./scripts/db-init.sql:/docker-entrypoint-initdb.d/01-db-init.sql:ro
    command: ["postgres", "-c", "shared_preload_libraries=pg_stat_statements"]
  redis:
    image: redis:7
    ports: ["6379:6379"]
  gcs:
    # GCS emulator for ingest uploads and rejected-rows reports (ADR-011). GCS_EMULATOR_HOST=http://127.0.0.1:4443
    image: fsouza/fake-gcs-server:1.52.2
    command: ["-scheme", "http", "-port", "4443", "-public-host", "127.0.0.1:4443", "-backend", "memory"]
    ports: ["127.0.0.1:4443:4443"]
`);
});

it("pins Node 22", () => {
  expect(readFileSync(join(root, ".nvmrc"), "utf8").trim()).toBe("22");
});

it("keeps the strict TypeScript gate", () => {
  const parsed = readJson(join(root, "tsconfig.base.json"));
  const compilerOptions =
    isRecord(parsed) && isRecord(parsed["compilerOptions"]) ? parsed["compilerOptions"] : {};
  expect(compilerOptions["strict"]).toBe(true);
  expect(compilerOptions["noUncheckedIndexedAccess"]).toBe(true);
  expect(compilerOptions["exactOptionalPropertyTypes"]).toBe(true);
});

it("publishes the lint-typecheck and test CI jobs (W0-1, audit M-1)", () => {
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const jobsBlock = ci.split(/^jobs:\s*$/m)[1];
  if (jobsBlock === undefined) {
    throw new Error("ci workflow has no jobs");
  }
  const jobNames = [...jobsBlock.matchAll(/^ {2}([a-z0-9-]+):\s*$/gm)].flatMap((match) => {
    const name = match[1];
    return name === undefined ? [] : [name];
  });
  expect(jobNames).toEqual(["lint-typecheck", "test"]);
});

it("typechecks every workspace package", () => {
  const packageDirs = ["packages", "apps"].flatMap((dir) =>
    readdirSync(join(root, dir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, dir, entry.name)),
  );
  expect(packageDirs.length).toBeGreaterThan(0);
  for (const pkg of packageDirs) {
    execFileSync("pnpm", ["exec", "tsc", "--noEmit", "-p", "tsconfig.json"], {
      cwd: pkg,
      stdio: "inherit",
    });
  }
});
