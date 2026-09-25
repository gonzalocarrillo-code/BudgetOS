import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OUT, generate } from "../../scripts/generate-api.mjs";

describe("generated API client", () => {
  it("matches apps/api/openapi.json (run pnpm --filter @budget/web api:generate)", async () => {
    expect(readFileSync(OUT, "utf8")).toBe(await generate());
  });
});
