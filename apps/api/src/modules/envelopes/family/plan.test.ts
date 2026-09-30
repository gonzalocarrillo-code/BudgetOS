import { FamilyInput } from "@budget/domain";
import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { planFamily, splitByPercent, type Node } from "./plan.js";

/** ADR-039 (product feedback 5): top-down family editing — % children follow, manual ones are flagged. */

const node = (id: keyof typeof ID, parentId: keyof typeof ID | null, amount: string | null, rule: Node["rule"], children: Array<keyof typeof ID> = [], currency = "USD"): Node => ({ id: ID[id], name: id, parentId: parentId ? ID[parentId] : null, currency, status: "APPROVED", amount, rule, children: children.map((c) => ID[c]) });
const tree = (...ns: Node[]) => new Map(ns.map((n) => [n.id, n]));
// Readable names for fixed UUIDs (FamilyInput takes envelope ids).
const ID = { P: "00000000-0000-4000-8000-00000000000a", A: "00000000-0000-4000-8000-00000000000b", B: "00000000-0000-4000-8000-00000000000c", A1: "00000000-0000-4000-8000-00000000000d", A2: "00000000-0000-4000-8000-00000000000e", E: "00000000-0000-4000-8000-00000000000f" } as const;
const name = Object.fromEntries(Object.entries(ID).map(([k, v]) => [v, k]));

describe("splitByPercent", () => {
  it("adds up to the parent to the cent (largest remainder)", () => {
    const out = splitByPercent(new Decimal("100.00"), [{ id: "a", pct: new Decimal("33.333333") }, { id: "b", pct: new Decimal("33.333333") }, { id: "c", pct: new Decimal("33.333334") }]);
    expect([...out.values()].reduce((s, x) => s.plus(x), new Decimal(0)).toFixed(2)).toBe("100.00");
    expect([...out.values()].map((x) => x.toFixed(2)).sort()).toEqual(["33.33", "33.33", "33.34"]);
    const part = splitByPercent(new Decimal("1000.00"), [{ id: "a", pct: new Decimal(25) }, { id: "b", pct: new Decimal(50) }]);
    expect([part.get("a")?.toFixed(2), part.get("b")?.toFixed(2)]).toEqual(["250.00", "500.00"]);
  });
});

describe("planFamily", () => {
  const family = () =>
    tree(
      node("P", null, "1000.00", null, ["A", "B"]),
      node("A", "P", "600.00", { mode: "percent", pct: "60" }, ["A1", "A2"]),
      node("B", "P", "300.00", { mode: "manual", pct: null }),
      node("A1", "A", "300.00", { mode: "percent", pct: "50" }),
      node("A2", "A", "100.00", { mode: "manual", pct: null }),
    );

  it("as it is: the direct children and how they add up", () => {
    const plan = planFamily(family(), ID.P, null);
    expect(plan.members.map((m) => [name[m.envelopeId], m.mode, m.pct, m.changed])).toEqual([["A", "percent", "60", false], ["B", "manual", null, false]]);
    expect(plan.sums).toEqual([{ parentId: ID.P, parentAmount: "1000.00", childrenTotal: "900.00", unallocated: "100.00", status: "under" }]);
  });

  it("approved amounts decide 'over'; drafts and pending requests are counted apart (round 12)", () => {
    // The Mexico case: children approved 42,000 + 46,000 of 96,800; their drafts add up to 120,100.
    const t = tree(
      { ...node("P", null, "96800.00", null, ["A", "B"]), approved: "96800.00", proposed: false },
      { ...node("A", "P", "56700.00", { mode: "manual", pct: null }), approved: "42000.00", proposed: true },
      { ...node("B", "P", "63400.00", { mode: "manual", pct: null }), approved: "46000.00", proposed: true },
    );
    const plan = planFamily(t, ID.P, null);
    expect(plan.approvedSum).toEqual({ parentId: ID.P, parentAmount: "96800.00", childrenTotal: "88000.00", unallocated: "8800.00", status: "under" });
    expect(plan.sums[0]).toMatchObject({ childrenTotal: "120100.00", unallocated: "-23300.00", status: "over" });
    expect(plan.proposals).toBe(2);
    // A family never approved has no approved sum; one with no drafts has no proposals.
    expect(planFamily(tree({ ...node("P", null, "10.00", null, ["A"]), approved: null }, node("A", "P", "5.00", null)), ID.P, null).approvedSum).toBeNull();
    expect(planFamily(family(), ID.P, null)).toMatchObject({ approvedSum: { status: "under", childrenTotal: "900.00" }, proposals: 0 });
  });

  it("the parent doubles: % children follow, down the tree; manual ones stay and are flagged", () => {
    const plan = planFamily(family(), ID.P, FamilyInput.parse({ parentAmount: "2000.00" }));
    const after = Object.fromEntries([plan.parent, ...plan.members].map((m) => [name[m.envelopeId], m.after]));
    // A2 (manual, unchanged) is not listed below the first level; its amount still counts in A's sum.
    expect(after).toEqual({ P: "2000.00", A: "1200.00", B: "300.00", A1: "600.00" });
    expect(plan.members.find((m) => m.envelopeId === ID.A1)?.level).toBe(2);
    expect(plan.sums).toEqual([
      { parentId: ID.P, parentAmount: "2000.00", childrenTotal: "1500.00", unallocated: "500.00", status: "under" },
      { parentId: ID.A, parentAmount: "1200.00", childrenTotal: "700.00", unallocated: "500.00", status: "under" },
    ]);
  });

  it("switching a child between % and an amount; over-allocation is flagged 'over'", () => {
    const plan = planFamily(family(), ID.P, FamilyInput.parse({ parentAmount: "1000.00", children: [{ envelopeId: ID.A, mode: "manual", amount: "800.00" }, { envelopeId: ID.B, mode: "percent", pct: "40" }] }));
    expect(plan.members.map((m) => [name[m.envelopeId], m.mode, m.pct, m.after])).toEqual([
      ["A", "manual", null, "800.00"],
      ["A1", "percent", "50", "400.00"],
      ["B", "percent", "40", "400.00"],
    ]);
    expect(plan.sums[0]).toEqual({ parentId: ID.P, parentAmount: "1000.00", childrenTotal: "1200.00", unallocated: "-200.00", status: "over" });
  });

  it("refuses a % child in another currency and a budget that is not the parent's child", () => {
    const mixed = tree(node("P", null, "1000.00", null, ["E"]), node("E", "P", "100.00", null, [], "EUR"));
    expect(() => planFamily(mixed, ID.P, FamilyInput.parse({ parentAmount: "1000.00", children: [{ envelopeId: ID.E, mode: "percent", pct: "10" }] }))).toThrow(/another currency/);
    expect(planFamily(mixed, ID.P, null).members[0]?.sameCurrency).toBe(false);
    expect(() => planFamily(family(), ID.P, FamilyInput.parse({ parentAmount: "1000.00", children: [{ envelopeId: ID.A1, mode: "manual", amount: "1.00" }] }))).toThrow(/own children/);
  });
});
