import { describe, expect, it } from "vitest";
import { isQualifierToken, lastToken, qualifiersAsFilter, replaceLastToken } from "./query.js";

describe("search box helpers", () => {
  it("completes the last token: a key keeps the colon, a value ends the token", () => {
    expect(lastToken("brazil reg")).toBe("reg");
    expect(replaceLastToken("brazil reg", "region:")).toBe("brazil region:");
    expect(replaceLastToken("brazil region:la", "region:LATAM")).toBe("brazil region:LATAM ");
    expect(lastToken("meta ")).toBe("");
  });

  it("knows a qualifier being typed from free text", () => {
    expect(isQualifierToken("re")).toBe(true);
    expect(isQualifierToken("r")).toBe(false);
    expect(isQualifierToken("country:BR")).toBe(true);
    expect(isQualifierToken("-status:")).toBe(true);
    expect(isQualifierToken("AR-2041")).toBe(false);
  });

  it("turns dimension qualifiers into an Explorer filter, ignoring the others", () => {
    expect(qualifiersAsFilter("meta region:LATAM -country:BR status:pending", new Set(["region", "country"]))).toEqual({
      logic: "and",
      children: [
        { field: { kind: "dimension", key: "region" }, op: "eq", value: "LATAM" },
        { field: { kind: "dimension", key: "country" }, op: "neq", value: "BR" },
      ],
    });
  });
});
