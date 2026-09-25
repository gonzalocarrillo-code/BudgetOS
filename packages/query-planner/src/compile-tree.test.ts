import { describe, expect, it } from "vitest";
import { compileTree, nodeDepth } from "./compile-tree.js";

const base = { workspaceId: "01927a00-0000-7000-8000-0000000000a1", templateId: "01927a00-0000-7000-8000-0000000000b2", period: { start: "2026-01-01", end: "2026-12-31" } };

describe("compileTree", () => {
  it("reads one template and period in depth-first order", () => {
    const c = compileTree(base);
    expect(c.sql).toContain(`ORDER BY string_to_array(node_path, '/') COLLATE "C"`);
    expect(c.values).toEqual([base.workspaceId, base.templateId, "2026-01-01", "2026-12-31"]);
  });
  it("narrows to one node's children, escaping LIKE wildcards in codes", () => {
    const c = compileTree({ ...base, parentPath: "LATAM/b_r%" });
    expect(c.values).toContain("LATAM/b\\_r\\%/%");
    expect(c.values).toContain(3);
    expect(compileTree({ ...base, parentPath: "" }).sql).toContain("END = 1");
  });
  it("depth of a path", () => {
    expect(nodeDepth("")).toBe(0);
    expect(nodeDepth("LATAM")).toBe(1);
    expect(nodeDepth("LATAM/BR/∅")).toBe(3);
  });
});
