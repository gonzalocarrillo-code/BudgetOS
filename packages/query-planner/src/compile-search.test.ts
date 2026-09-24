import { parseSearch, type ScopeFilter } from "@budget/domain";
import { describe, expect, it } from "vitest";
import { compileSearch, parseRelative, searchTypes, type SearchContext } from "./compile-search.js";

const ctx: SearchContext = { workspaceId: "01927a00-0000-7000-8000-0000000000a1", userId: "01927a00-0000-7000-8000-0000000000b2", scopes: null, limitPerType: 5 };
const compile = (q: string, over: Partial<SearchContext> = {}) => compileSearch(parseSearch(q), { ...ctx, ...over });

describe("compileSearch", () => {
  it("maps type aliases and refuses unknown types", () => {
    expect(searchTypes(["approval", "value", "envelope", "approval"])).toEqual(["approval_request", "dimension_value", "envelope"]);
    expect(() => searchTypes(["envelopes"])).toThrow(/Unknown search types/);
    expect(compile("type:approval x").types).toEqual(["approval_request"]);
  });

  it("binds every value; numeric qualifiers must be numbers, except cpa:>target", () => {
    const c = compile("budget:>1000 pace:<0.9 cpa:>target country:BR -tag:old x");
    expect(c.values).toContain("1000");
    expect(c.values).toContain("0.9");
    expect(c.sql).toContain("(numeric_facets->>'cpa_target')::numeric");
    expect(c.sql).not.toContain("BR");
    expect(() => compile("budget:lots")).toThrow(/budget needs a number/);
    expect(() => compile("has:closed-thread")).toThrow(/open-thread/);
    expect(() => compile("mentions:someone")).toThrow(/@me/);
  });

  it("an unrestricted caller gets no scope condition; a scoped one gets its scopes, tags and registry excepted", () => {
    expect(compile("x").sql).not.toContain("dimension_values->>");
    const scope = { logic: "and", children: [{ field: { kind: "dimension", key: "region" }, op: "descends_from", value: "latam" }] } as ScopeFilter;
    const scoped = compile("x", { scopes: [scope] });
    expect(scoped.sql).toContain("dv.path <@ x.path");
    expect(scoped.values).toContainEqual(["tag", "dimension_value"]);
    const none = compile("x", { scopes: [] });
    expect(none.sql).toContain("OR FALSE");
  });

  it("parses relative update windows", () => {
    expect(parseRelative("7d")).toBe("7 days");
    expect(parseRelative("12h")).toBe("12 hours");
    expect(() => parseRelative("soon")).toThrow(/updated needs/);
  });
});
