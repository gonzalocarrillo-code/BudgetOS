import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { registryOpenApiDocument } from "./openapi.js";

it("committed openapi matches the registry document", () => {
  const committed = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as unknown;
  expect(committed).toEqual(registryOpenApiDocument());
});
