import { describe, expect, it } from "vitest";
import { CreateExportInput, readScopeFilter, type ScopedRole } from "./index.js";

const dim = (key: string) => ({ kind: "dimension" as const, key });

describe("readScopeFilter", () => {
  it("is null when a granting assignment covers the workspace", () => {
    const a: ScopedRole[] = [
      { role: "VIEWER", scope: { logic: "and", children: [{ field: dim("region"), op: "eq", value: "LATAM" }] } },
      { role: "PLANNER", scope: {} },
    ];
    expect(readScopeFilter(a, "envelope.read")).toBeNull();
  });

  it("ORs the granting scopes; eq becomes in, a multi-value descends_from becomes an OR", () => {
    const a: ScopedRole[] = [
      { role: "VIEWER", scope: { logic: "and", children: [{ field: dim("region"), op: "eq", value: "LATAM" }] } },
      { role: "PLANNER", scope: { logic: "and", not: true, children: [{ field: dim("region"), op: "descends_from", value: ["EMEA", "APAC"] }] } },
    ];
    expect(readScopeFilter(a, "envelope.read")).toEqual({
      logic: "or",
      children: [
        { logic: "and", children: [{ field: dim("region"), op: "in", value: ["LATAM"] }] },
        { logic: "and", not: true, children: [{ logic: "or", children: [{ field: dim("region"), op: "descends_from", value: "EMEA" }, { field: dim("region"), op: "descends_from", value: "APAC" }] }] },
      ],
    });
  });

  it("ignores assignments that do not grant the action and refuses when none does", () => {
    const a: ScopedRole[] = [{ role: "VIEWER", scope: {} }];
    expect(() => readScopeFilter(a, "closure.close")).toThrow(/No role grants closure.close/);
  });
});

describe("CreateExportInput", () => {
  const query = { workspaceId: "0199b5a0-0000-7000-8000-000000000001", period: { kind: "relative", preset: "current_year" } };
  it("takes a grid query and a safe filename", () => {
    expect(CreateExportInput.parse({ kind: "xlsx", query, filename: "Q3 LATAM" }).query.measures).toEqual(["budget", "actual", "projected", "pace_index"]);
    expect(CreateExportInput.safeParse({ kind: "csv", query, filename: "../etc/passwd" }).success).toBe(false);
    expect(CreateExportInput.safeParse({ kind: "pdf", query }).success).toBe(false);
  });
});
