import { describe, expect, it } from "vitest";
import { activeMention, bodyParts, fromCanonical, toCanonical } from "./mentions.js";

const ana = { type: "user" as const, id: "0190a000-0000-7000-8000-000000000001", name: "Ana" };
const anaMaria = { type: "user" as const, id: "0190a000-0000-7000-8000-000000000002", name: "Ana Maria" };
const team = { type: "group" as const, id: "0190a000-0000-7000-8000-000000000003", name: "LATAM team" };

describe("mentions (ADR-025)", () => {
  it("writes the canonical form, longest name first, and reads it back", () => {
    const body = toCanonical("@Ana Maria and @Ana, cc @LATAM team", [ana, anaMaria, team]);
    expect(body).toBe(`@[user:${anaMaria.id}] and @[user:${ana.id}], cc @[group:${team.id}]`);
    const names = { users: { [ana.id]: "Ana", [anaMaria.id]: "Ana Maria" }, groups: { [team.id]: "LATAM team" } };
    expect(fromCanonical(body, names)).toEqual({ text: "@Ana Maria and @Ana, cc @LATAM team", picked: [anaMaria, ana, team] });
    expect(bodyParts(body, names).filter((p) => p.kind === "mention").map((p) => (p.kind === "mention" ? p.name : ""))).toEqual(["Ana Maria", "Ana", "LATAM team"]);
  });

  it("finds the @partial at the caret, and only there", () => {
    expect(activeMention("hi @bud", 7)).toEqual({ start: 3, query: "bud" });
    expect(activeMention("@", 1)).toEqual({ start: 0, query: "" });
    expect(activeMention("mail a@b", 8)).toBeNull();
    expect(activeMention("hi @bud there", 13)).toBeNull();
  });
});
