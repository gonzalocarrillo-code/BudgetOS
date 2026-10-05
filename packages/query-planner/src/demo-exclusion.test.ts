import { QueryRequest } from "@budget/domain";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileQuery, compileTotals } from "./index.js";
import { closePools, runAsApp, type Row } from "./test-support/db.js";
import { PERIOD, TODAY, cleanupOrg, createOrg, createWorkspace, insertEnvelope, type FixtureOrg } from "./test-support/fixtures.js";

/**
 * T-5 (audit): demo envelopes and demo facts (spec §27) are excluded from rows and totals by
 * default, so a workspace that has gone on to hold real budgets never mixes demo money into its
 * numbers. `includeDemo: true` (Home's demo banner query, the Explorer on a pure-demo workspace)
 * brings them back.
 */
let org: FixtureOrg;
let ws: string;

beforeAll(async () => {
  org = await createOrg();
  ws = await createWorkspace(org);
  await insertEnvelope(org, ws, {
    name: "Real",
    parentId: null,
    geo: "br",
    platform: "meta",
    status: "APPROVED",
    start: PERIOD.start,
    end: PERIOD.end,
    versions: [{ amount: "1000.00", status: "APPROVED", approvedAt: "2026-01-02T00:00:00Z" }],
    spend: [{ date: "2026-01-10", amount: "100.00" }],
    kpi: [{ date: "2026-01-10", metric: "conversions", value: "10" }],
  });
  await insertEnvelope(org, ws, {
    name: "Demo",
    parentId: null,
    geo: "mx",
    platform: "google",
    status: "APPROVED",
    start: PERIOD.start,
    end: PERIOD.end,
    demo: true,
    versions: [{ amount: "500.00", status: "APPROVED", approvedAt: "2026-01-02T00:00:00Z" }],
    spend: [{ date: "2026-01-10", amount: "50.00" }],
    kpi: [{ date: "2026-01-10", metric: "conversions", value: "5" }],
  });
});

afterAll(async () => {
  if (org) await cleanupOrg(org);
  await closePools();
});

const request = (includeDemo?: boolean) =>
  QueryRequest.parse({ workspaceId: ws, period: { kind: "range", ...PERIOD }, limit: 10, measures: ["budget", "actual"], ...(includeDemo === undefined ? {} : { includeDemo }) });
const as = { workspaceId: "", userId: "" };
const names = (rows: Row[]) => rows.map((r) => String(r["name"])).sort();
const money = (v: unknown) => new Decimal(String(v)).toFixed(2);

describe("demo exclusion (T-5)", () => {
  it("excludes the demo envelope and its facts from rows and totals by default", async () => {
    const rows = await runAsApp(compileQuery(request(), PERIOD, TODAY), { ...as, workspaceId: ws, userId: org.users.u1 });
    expect(names(rows)).toEqual(["Real"]);
    const [totals] = await runAsApp(compileTotals(request(), PERIOD, TODAY), { ...as, workspaceId: ws, userId: org.users.u1 });
    expect(money(totals?.["budget"])).toBe("1000.00");
    expect(money(totals?.["actual"])).toBe("100.00");
    expect(Number(totals?.["leaf_count"])).toBe(1);
  });

  it("includes the demo envelope and its facts with includeDemo: true", async () => {
    const rows = await runAsApp(compileQuery(request(true), PERIOD, TODAY), { ...as, workspaceId: ws, userId: org.users.u1 });
    expect(names(rows)).toEqual(["Demo", "Real"]);
    const [totals] = await runAsApp(compileTotals(request(true), PERIOD, TODAY), { ...as, workspaceId: ws, userId: org.users.u1 });
    expect(money(totals?.["budget"])).toBe("1500.00");
    expect(money(totals?.["actual"])).toBe("150.00");
    expect(Number(totals?.["leaf_count"])).toBe(2);
  });
});
