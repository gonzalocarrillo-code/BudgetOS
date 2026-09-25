import { describe, expect, it } from "vitest";
import { isLucideName } from "./icons.js";

describe("Lucide icon names (T-031 icon picker)", () => {
  it("accepts Lucide's own kebab names, digits included, and nothing else", () => {
    for (const name of ["globe", "flag", "target", "bar-chart-2", "arrow-down-0-1", "arrow-down-01", "axis-3d", "user-round"]) expect(isLucideName(name), name).toBe(true);
    for (const name of ["", "not-an-icon", "Globe", "globe-", "../globe", "glo be"]) expect(isLucideName(name), name).toBe(false);
  });
});
