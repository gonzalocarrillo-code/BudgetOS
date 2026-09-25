import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";

/** apps/api/openapi.json → apps/web/src/lib/api.gen.ts (spec §17). `--check` fails when the file is stale. */
const here = dirname(fileURLToPath(import.meta.url));
export const SPEC = join(here, "../../api/openapi.json");
export const OUT = join(here, "../src/lib/api.gen.ts");

export async function generate(): Promise<string> {
  const ast = await openapiTS(JSON.parse(readFileSync(SPEC, "utf8")) as Parameters<typeof openapiTS>[0]);
  return `/* Generated from apps/api/openapi.json by scripts/generate-api.mts. Do not edit. */\n${astToString(ast)}`;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const text = await generate();
  if (process.argv.includes("--check")) {
    if (readFileSync(OUT, "utf8") !== text) {
      process.stderr.write("api.gen.ts is stale: run pnpm --filter @budget/web api:generate\n");
      process.exit(1);
    }
  } else writeFileSync(OUT, text);
}
