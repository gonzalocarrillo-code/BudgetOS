import { describe, expect, it } from "vitest";
import type { DimensionValue } from "../../lib/queries.js";
import { flattenTree, parseValueLines, subtreeIds, toCode, toKey } from "./values.js";

const v = (id: string, code: string, label: string, parentValueId: string | null = null): DimensionValue => ({ id, code, label, path: "", parentValueId, isActive: true, aliases: [], mergedIntoId: null });

describe("registry value helpers (T-031)", () => {
  it("keys and codes from labels", () => {
    expect(toKey("Market tier")).toBe("market_tier");
    expect(toKey("2024 Promo wave")).toBe("promo_wave");
    expect(toKey("x")).toBe("");
    expect(toCode("Non-brand")).toBe("non_brand");
    expect(toCode("São Paulo")).toBe("sao_paulo");
  });

  it("parses one value per line, `Parent > Child` nesting, `code = Label`, and skips what exists", () => {
    const existing = [v("1", "tier1", "Tier 1")];
    expect(parseValueLines("Tier 1 > Core\nTier 1 > Core > Core A\nt2 = Tier two\n\nTier 1", existing)).toEqual([
      { code: "core", label: "Core", parentCode: "tier1" },
      { code: "core_a", label: "Core A", parentCode: "core" },
      { code: "t2", label: "Tier two" },
    ]);
  });

  it("orders the tree parents-first and finds a subtree", () => {
    const values = [v("c", "c", "Child", "p"), v("p", "p", "Parent"), v("g", "g", "Grandchild", "c"), v("a", "a", "Another")];
    expect(flattenTree(values).map((n) => [n.value.code, n.depth])).toEqual([["a", 0], ["p", 0], ["c", 1], ["g", 2]]);
    expect([...subtreeIds(values, "p")].sort()).toEqual(["c", "g", "p"]);
  });
});
