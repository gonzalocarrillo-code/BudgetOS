import { QueryRequest, type Predicate } from "@budget/domain";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileQuery, compileTotals } from "./index.js";
import { closePools, runAsApp, type Row } from "./test-support/db.js";
import { PERIOD, TODAY, cleanupOrg, createOrg, createWorkspace, insertEnvelope, type FixtureOrg } from "./test-support/fixtures.js";

/**
 * HO-003 (ADR-062): pace can count time gone through the last day the actuals cover instead of
 * today. Q1 (90 days), a 9,000 budget with 3,000 spent by 20 January. Today (14 February) is day 45,
 * half the quarter; the actuals cover through 31 January, day 31.
 */
let org: FixtureOrg;
let ws: string;

beforeAll(async () => {
  org = await createOrg();
  ws = await createWorkspace(org);
  await insertEnvelope(org, ws, { name: "Search", parentId: null, platform: "google", geo: "br", status: "APPROVED", start: PERIOD.start, end: PERIOD.end, versions: [{ amount: "9000.00", status: "APPROVED", approvedAt: "2026-01-02T00:00:00Z" }], spend: [{ date: "2026-01-20", amount: "3000.00" }] });
});

afterAll(async () => {
  if (org) await cleanupOrg(org);
  await closePools();
});

const LIVE: Predicate = { field: { kind: "attr", key: "status" }, op: "neq", value: "ARCHIVED" };
const request = () => QueryRequest.parse({ workspaceId: ws, period: { kind: "range", ...PERIOD }, limit: 10, measures: ["budget", "actual", "pace_index"], filter: { logic: "and", children: [LIVE] } });
const as = { workspaceId: "", userId: "" };
const pace = (r: Row | undefined) => new Decimal(String(r?.["pace_index"])).toDecimalPlaces(4).toString();

describe("pace as of the data (ADR-062)", () => {
  it("counts time gone to today by default", async () => {
    const [row] = await runAsApp(compileQuery(request(), PERIOD, TODAY), { ...as, workspaceId: ws, userId: org.users.u1 });
    expect(pace(row)).toBe(new Decimal(3000).div(9000).div(new Decimal(45).div(90)).toDecimalPlaces(4).toString()); // 0.6667
  });

  it("counts time gone through the day the actuals cover, for rows and totals alike", async () => {
    const opts = { elapsedThrough: "2026-01-31" };
    const expected = new Decimal(3000).div(9000).div(new Decimal(31).div(90)).toDecimalPlaces(4).toString(); // 0.9677
    const [row] = await runAsApp(compileQuery(request(), PERIOD, TODAY, opts), { ...as, workspaceId: ws, userId: org.users.u1 });
    expect(pace(row)).toBe(expected);
    const [t] = await runAsApp(compileTotals(request(), PERIOD, TODAY, opts), { ...as, workspaceId: ws, userId: org.users.u1 });
    expect(pace(t)).toBe(expected);
  });

  it("never counts past today, and a period with no time gone yet has no pace", async () => {
    const [capped] = await runAsApp(compileQuery(request(), PERIOD, TODAY, { elapsedThrough: "2026-03-20" }), { ...as, workspaceId: ws, userId: org.users.u1 });
    expect(pace(capped)).toBe(new Decimal(3000).div(9000).div(new Decimal(45).div(90)).toDecimalPlaces(4).toString());
    const [before] = await runAsApp(compileQuery(request(), PERIOD, TODAY, { elapsedThrough: "2025-12-31" }), { ...as, workspaceId: ws, userId: org.users.u1 });
    expect(before?.["pace_index"]).toBeNull();
  });
});
