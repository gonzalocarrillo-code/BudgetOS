import { QueryRequest } from "@budget/domain";
import { Decimal } from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileQuery, compileTotals } from "./index.js";
import { closePools, runAsApp, type Row } from "./test-support/db.js";
import { PERIOD, TODAY, cleanupOrg, createOrg, createWorkspace, insertEnvelope, type FixtureOrg } from "./test-support/fixtures.js";

/**
 * T-5 (audit): demo envelopes and demo facts (spec §27) are excluded from rows and totals once the
 * workspace has a real (non-demo, live) budget, so it never mixes demo money into its numbers. A
 * pure-demo workspace (onboarding, before the first real budget) shows them automatically — no
 * caller needs `includeDemo`, which only forces them in unconditionally.
 */
let org: FixtureOrg;
let wsPure: string;
let wsMixed: string;

beforeAll(async () => {
  org = await createOrg();
  wsPure = await createWorkspace(org);
  await insertEnvelope(org, wsPure, {
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

  wsMixed = await createWorkspace(org);
  await insertEnvelope(org, wsMixed, {
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
  await insertEnvelope(org, wsMixed, {
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

const request = (workspaceId: string, includeDemo?: boolean) =>
  QueryRequest.parse({ workspaceId, period: { kind: "range", ...PERIOD }, limit: 10, measures: ["budget", "actual"], ...(includeDemo === undefined ? {} : { includeDemo }) });
const as = { workspaceId: "", userId: "" };
const names = (rows: Row[]) => rows.map((r) => String(r["name"])).sort();
const money = (v: unknown) => new Decimal(String(v)).toFixed(2);

describe("demo exclusion (T-5)", () => {
  it("a pure-demo workspace (no real budget yet) includes the demo envelope and its facts by default", async () => {
    const rows = await runAsApp(compileQuery(request(wsPure), PERIOD, TODAY), { ...as, workspaceId: wsPure, userId: org.users.u1 });
    expect(names(rows)).toEqual(["Demo"]);
    const [totals] = await runAsApp(compileTotals(request(wsPure), PERIOD, TODAY), { ...as, workspaceId: wsPure, userId: org.users.u1 });
    expect(money(totals?.["budget"])).toBe("500.00");
    expect(money(totals?.["actual"])).toBe("50.00");
    expect(Number(totals?.["leaf_count"])).toBe(1);
  });

  it("includeDemo: true changes nothing for a pure-demo workspace (already included)", async () => {
    const rows = await runAsApp(compileQuery(request(wsPure, true), PERIOD, TODAY), { ...as, workspaceId: wsPure, userId: org.users.u1 });
    expect(names(rows)).toEqual(["Demo"]);
  });

  it("once a real budget exists, the demo envelope and its facts are excluded from rows and totals by default", async () => {
    const rows = await runAsApp(compileQuery(request(wsMixed), PERIOD, TODAY), { ...as, workspaceId: wsMixed, userId: org.users.u1 });
    expect(names(rows)).toEqual(["Real"]);
    const [totals] = await runAsApp(compileTotals(request(wsMixed), PERIOD, TODAY), { ...as, workspaceId: wsMixed, userId: org.users.u1 });
    expect(money(totals?.["budget"])).toBe("1000.00");
    expect(money(totals?.["actual"])).toBe("100.00");
    expect(Number(totals?.["leaf_count"])).toBe(1);
  });

  it("includeDemo: true includes the demo envelope and its facts even with a real budget present", async () => {
    const rows = await runAsApp(compileQuery(request(wsMixed, true), PERIOD, TODAY), { ...as, workspaceId: wsMixed, userId: org.users.u1 });
    expect(names(rows)).toEqual(["Demo", "Real"]);
    const [totals] = await runAsApp(compileTotals(request(wsMixed, true), PERIOD, TODAY), { ...as, workspaceId: wsMixed, userId: org.users.u1 });
    expect(money(totals?.["budget"])).toBe("1500.00");
    expect(money(totals?.["actual"])).toBe("150.00");
    expect(Number(totals?.["leaf_count"])).toBe(2);
  });
});
