import { LIVE_LEAVES, QueryRequest } from "@budget/domain";
import { describe, expect, it } from "vitest";
import { bigQuerySupported, compileAggregateBq, compileAggregateTotalsBq, encodeCursor } from "./index.js";

/**
 * ADR-042: the set-based planner in BigQuery SQL. No BigQuery here: the SQL is checked for the
 * dialect (no Postgres syntax), the workspace cut on every table, and complete parameters; the
 * shape is the one aggregate.test.ts proves equal to the per-envelope planner on Postgres.
 */

const ws = "01a0e0da-e7e9-7f9a-9212-1c166382caf2";
const period = { start: "2026-01-01", end: "2026-12-31" };
const q = (body: Record<string, unknown>) => QueryRequest.parse({ workspaceId: ws, period: { kind: "range", ...period }, measures: ["budget", "actual", "projected", "remaining", "pace_index", "spend_to_date_pct"], ...body });
const leaves = (...more: unknown[]) => ({ logic: "and", children: [...LIVE_LEAVES, ...more] });

describe("compileAggregateBq", () => {
  it("emits BigQuery SQL: named params, QUALIFY, UNNEST, no Postgres syntax, the workspace cut everywhere", () => {
    const c = compileAggregateBq(q({ groupBy: ["country", "platform"], filter: leaves({ field: { kind: "dimension", key: "region" }, op: "descends_from", value: "latam" }, { field: { kind: "dimension", key: "platform" }, op: "in", value: ["meta", "tiktok"] }), sort: [{ key: "budget", dir: "desc" }], limit: 100 }), period, "2026-06-30", "acme-prod.budget_os_prod", { hasProjections: true });
    expect(c.sql).not.toMatch(/\$\d|::|DISTINCT ON|LATERAL|= ANY\(|ILIKE|<@/);
    expect(c.sql).toMatch(/QUALIFY ROW_NUMBER\(\) OVER/);
    expect(c.sql).toMatch(/IN UNNEST\(@p\d+\)/);
    expect(c.sql).toMatch(/STARTS_WITH\(dv\.path, CONCAT\(anc\.path, '\.'\)\)/);
    expect(c.sql.match(/`acme-prod\.budget_os_prod\.[a-z_]+`/g)?.length).toBeGreaterThan(8);
    expect(c.sql).toMatch(/e\.workspace_id = @p1/);
    expect(c.sql).toMatch(/sf\.workspace_id = @p1/);
    expect(c.sql).toMatch(/x\.workspace_id = @p1/);
    const used = [...c.sql.matchAll(/@(p\d+|elapsed)/g)].map((m) => m[1] as string);
    expect(new Set(used)).toEqual(new Set(Object.keys(c.params)));
    expect(c.params["elapsed"]).toBe("0.49589041095890410959");
    expect(c.types["elapsed"]).toBe("BIGNUMERIC");
    expect(c.orderKeys.map((o) => o.col)).toEqual(["budget", "dim_country", "dim_platform"]);
  });

  it("pages with the per-envelope planner's cursor; totals have no GROUP BY", () => {
    const page = compileAggregateBq(q({ groupBy: ["country"], limit: 10, cursor: encodeCursor(["BR"]) }), period, "2026-06-30", "budget_os_dev");
    expect(page.sql).toMatch(/WHERE \(\(q\.dim_country > @p\d+ OR q\.dim_country IS NULL\)\)/);
    const totals = compileAggregateTotalsBq(q({ filter: leaves() }), period, "2026-06-30", "budget_os_dev", { hasProjections: false });
    expect(totals.sql).not.toMatch(/GROUP BY d0|proj AS/);
    expect(totals.sql).toMatch(/COUNT\(\*\) AS leaf_count FROM m$/);
  });

  it("refuses what BigQuery does not answer and a dataset that is not an identifier", () => {
    expect(bigQuerySupported(q({ groupBy: ["country"], filter: { logic: "and", children: [{ field: { kind: "attr", key: "tag" }, op: "eq", value: "q4" }] } }))).toBe(false);
    expect(bigQuerySupported(q({ groupBy: ["country"], asOf: "2026-01-01T00:00:00.000Z" }))).toBe(false);
    expect(bigQuerySupported(q({ groupBy: ["country"], filter: leaves() }))).toBe(true);
    expect(() => compileAggregateBq(q({ groupBy: ["country"] }), period, "2026-06-30", "x`; DROP TABLE y; --")).toThrow(/dataset/);
  });
});
