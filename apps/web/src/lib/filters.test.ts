import { describe, expect, it } from "vitest";
import { decodeFilter, encodeFilter } from "./filters.js";

describe("URL filters", () => {
  it("round-trips a FilterGroup and rejects garbage", () => {
    const f = { logic: "and" as const, children: [{ field: { kind: "dimension" as const, key: "country" }, op: "eq" as const, value: "BR" }] };
    const encoded = encodeFilter(f);
    expect(encoded).toMatch(/^[A-Za-z0-9+\-$]+$/);
    expect(decodeFilter(encoded)).toEqual(f);
    expect(() => decodeFilter("not-a-filter")).toThrow();
  });
});
