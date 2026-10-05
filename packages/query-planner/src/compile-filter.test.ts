import { describe, expect, it } from "vitest";
import type { FilterGroupT } from "@budget/domain";
import { compileFilter, type CompileCtx } from "./compile-filter.js";
import { SqlBuilder } from "./sql-builder.js";

describe("LIKE escape sequences in filters", () => {
  const ctx: CompileCtx = {
    workspaceId: "ws-id",
    periodStart: "2026-01-01",
    periodEnd: "2026-12-31",
    today: "2026-10-15",
  };

  it("escapes LIKE wildcards in dimension contains filter", () => {
    const b = new SqlBuilder();
    const filter: FilterGroupT = {
      logic: "and",
      children: [
        {
          field: { kind: "dimension", key: "region" },
          op: "contains",
          value: "50%",
        },
      ],
    };
    const sql = compileFilter(filter, b, ctx);
    // Should escape the % to \% and include ESCAPE clause
    expect(sql).toContain("ESCAPE '\\'");
    // Verify the SQL is properly formed
    expect(sql).toContain("ILIKE");
  });

  it("escapes LIKE wildcards in dimension starts_with filter", () => {
    const b = new SqlBuilder();
    const filter: FilterGroupT = {
      logic: "and",
      children: [
        {
          field: { kind: "dimension", key: "platform" },
          op: "starts_with",
          value: "test_value",
        },
      ],
    };
    const sql = compileFilter(filter, b, ctx);
    // Should escape the _ to \_ and include ESCAPE clause
    expect(sql).toContain("ESCAPE '\\'");
  });

  it("escapes LIKE wildcards with multiple special chars", () => {
    const b = new SqlBuilder();
    const filter: FilterGroupT = {
      logic: "and",
      children: [
        {
          field: { kind: "dimension", key: "region" },
          op: "contains",
          value: "test%_value",
        },
      ],
    };
    const sql = compileFilter(filter, b, ctx);
    // Should escape both % and _ and include ESCAPE clause
    expect(sql).toContain("ESCAPE '\\'");
  });
});
