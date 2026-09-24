import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { openApiDocument } from "./openapi.js";

const path = new URL("../openapi.json", import.meta.url);

/** Regenerate with `UPDATE_OPENAPI=1 pnpm --filter @budget/api test src/openapi.test.ts`. */
it("committed openapi matches the API document", () => {
  if (process.env["UPDATE_OPENAPI"] === "1") writeFileSync(path, JSON.stringify(openApiDocument(), null, 2) + "\n");
  const committed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  expect(committed).toEqual(openApiDocument());
});
