import { randomUUID } from "node:crypto";
import { asOrgAdmin, type Tx } from "@budget/db";
import { deleteWorkspaceForTests } from "@budget/workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appDb, ownerDb, startHarness, testUser, type Harness, type TestUser } from "../../test-support/harness.js";
import { CLOSURE_SINK, RecordingClosureSink } from "./sink.js";

/**
 * T-024 (spec §15) through HTTP. Done-when: an envelope locked by closing its period rejects a
 * draft with 423. Also: every write and approval step on it is 423, the closure writes each
 * template's rows (period and months) to the sink, restating needs admin + reason and gives every
 * envelope its prior status back unless another closed closure still covers it, and the next
 * close of a period writes a new table named by its closure id, never over the first table.
 *
 * W3-1 (audit I-4, ADR-018 addendum): the close is two transactions with the sink in between. A
 * sink failure leaves a `failed` closure and unlocked envelopes; a concurrent close is 409; while
 * the sink writes, other writes in the workspace go through, restate is 409, and a stale `closing`
 * closure can be abandoned.
 */

const owner = ownerDb();
const app = appDb();
let h: Harness;
let sink: RecordingClosureSink;
const orgId = randomUUID();
const ws = randomUUID();
const planner = testUser("t024-planner", randomUUID());
const finance = testUser("t024-finance", randomUUID());
const approver = testUser("t024-approver", randomUUID());
const admin = testUser("t024-admin", randomUUID());
const orgAdmin = testUser("t024-org", randomUUID());
const X = { "x-workspace-id": ws };
const env: Record<string, { id: string; draftVersionId: string }> = {};
// W0-6: the owner has no BYPASSRLS; every raw/Prisma call against the workspace-scoped tables
// below needs the org-admin tenant context real writes get from withTenant.
const asAdmin = <T,>(fn: (tx: Tx) => Promise<T>) => asOrgAdmin(owner, fn, orgId);

type Res = { status: number; body: Record<string, unknown> };
async function call(user: TestUser, method: "GET" | "POST" | "PATCH", url: string, body?: unknown): Promise<Res> {
  return h.call(method, `/api/v1${url}`, await h.mint(user), { headers: X, ...(body === undefined ? {} : { body }) });
}
async function envelope(key: string, name: string, amount: string, dates = { startDate: "2026-01-01", endDate: "2026-12-31" }) {
  const created = await call(planner, "POST", `/workspaces/${ws}/envelopes`, { name, dimensionValues: { region: key }, ...dates, currency: "USD", amount, ownerId: planner.id });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = String(created.body["id"]);
  const submitted = await call(planner, "POST", `/envelopes/${id}/submit`, { versionId: created.body["draftVersionId"] });
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
  env[key] = { id, draftVersionId: String(created.body["draftVersionId"]) };
}
const status = async (key: string) => (await asAdmin((tx) => tx.envelope.findUniqueOrThrow({ where: { id: env[key]?.id ?? "" }, select: { status: true } }))).status;
const head = async (key: string) => {
  const e = await asAdmin((tx) => tx.envelope.findUniqueOrThrow({ where: { id: env[key]?.id ?? "" }, select: { currentVersionId: true, draftVersionId: true } }));
  return e.draftVersionId ?? e.currentVersionId;
};
const close = (periodKey: string, user: TestUser = finance) => call(user, "POST", `/workspaces/${ws}/closures`, { periodKey });
const auditsOf = async (closureId: string) =>
  (await asAdmin((tx) => tx.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_event WHERE entity_type = 'period_closure' AND entity_id = $1::uuid`, closureId))).map((a) => a.action).sort();
const topicsOf = async (closureId: string) =>
  (await asAdmin((tx) => tx.$queryRawUnsafe<Array<{ topic: string }>>(`SELECT topic FROM outbox WHERE workspace_id = $1::uuid AND payload->>'closureId' = $2`, ws, closureId))).map((o) => o.topic).sort();
/** Resolves to "timeout" when `p` has not settled within `ms`. */
function within<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), ms)));
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
function gate() {
  let release = () => {};
  const wait = new Promise<void>((resolve) => (release = resolve));
  return { wait, release: () => release() };
}

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "t024" } });
  // W0-6: workspace has no owner_bootstrap policy; it needs the org-admin tenant context real
  // writes get from withTenant, with the real org id for its exact org_id match.
  await asAdmin((tx) => tx.workspace.create({ data: { id: ws, orgId, slug: `t024-${ws}`, name: "T-024", reportingCurrency: "USD", fiscalYearStartMonth: 1 } }));
  await owner.user.createMany({ data: [planner, finance, approver, admin, orgAdmin].map((u) => ({ id: u.id, orgId, email: u.email, name: u.sub, googleSub: `g-${u.sub}` })) });
  await owner.roleAssignment.createMany({
    data: [
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: planner.id, role: "PLANNER", createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: finance.id, role: "FINANCE", createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: approver.id, role: "APPROVER", createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: admin.id, role: "WORKSPACE_ADMIN", createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: null, principalType: "user", principalId: orgAdmin.id, role: "ORG_ADMIN", createdBy: orgAdmin.id },
    ],
  });
  const region = randomUUID();
  await asAdmin(async (tx) => {
    await tx.$executeRawUnsafe(`INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by) VALUES ($1::uuid, $2::uuid, NULL, 'region', 'Region', 'ENUM', $3::uuid)`, region, orgId, orgAdmin.id);
    for (const code of ["latam", "emea", "apac"]) await tx.$executeRawUnsafe(`INSERT INTO dimension_value (id, dimension_id, code, label) VALUES ($1::uuid, $2::uuid, $3, $3)`, randomUUID(), region, code);
    await tx.hierarchyTemplate.create({ data: { id: randomUUID(), workspaceId: ws, name: "By region", path: ["region"], createdBy: orgAdmin.id } });
    await tx.approvalPolicy.createMany({
      data: [
        { id: randomUUID(), workspaceId: ws, name: "Large", priority: 1, conditions: { amountAbs: { gte: 1000 } }, chain: [{ role: "APPROVER", minApprovals: 1, timeoutHours: 48 }], blockSelfApproval: true },
        { id: randomUUID(), workspaceId: ws, name: "Auto", priority: 2, conditions: {}, chain: [], blockSelfApproval: true },
      ],
    });
  });
  h = await startHarness();
  sink = h.app.get(CLOSURE_SINK, { strict: false }) as RecordingClosureSink;
  await envelope("latam", "Brazil always-on", "600.00");
  await envelope("emea", "Europe launch", "2000.00"); // pending: the Large policy needs an approver
  await envelope("apac", "APAC 2025 wrap-up", "50.00", { startDate: "2025-10-01", endDate: "2025-12-31" });
  await owner.$executeRawUnsafe(`SELECT ensure_fact_partitions('2026-01-01'::date, 3)`);
  await asAdmin(async (tx) => {
    for (const [day, amount] of [["2026-01-15", "100.00"], ["2026-02-10", "40.50"], ["2026-04-02", "7.00"]] as const) {
      await tx.$executeRawUnsafe(
        `INSERT INTO spend_fact (id, workspace_id, envelope_id, dimension_values, period_date, currency, amount, amount_reporting, source_system, source_run_id, source_row_hash, loaded_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, '{"region":"latam"}', $4::date, 'USD', $5::numeric, $5::numeric, 'csv', $6::uuid, $1, now())`,
        randomUUID(), ws, env["latam"]?.id, day, amount, randomUUID(),
      );
    }
  });
}, 60_000);

afterAll(async () => {
  await h?.close();
  // W3-11 (audit I-32): deletes every row that FKs to this workspace (and the workspace row
  // itself), in the same order `purgeWorkspace` validates against production.
  // W0-6: the owner has no BYPASSRLS; pass orgId so deleteWorkspaceForTests runs under org-admin
  // tenant context.
  await deleteWorkspaceForTests(owner, ws, orgId);
  await owner.roleAssignment.deleteMany({ where: { principalId: orgAdmin.id } });
  await asAdmin(async (tx) => {
    await tx.$executeRawUnsafe(`DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`, orgId);
    await tx.$executeRawUnsafe(`DELETE FROM dimension WHERE org_id = $1::uuid`, orgId);
  });
  await owner.user.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("closures (T-024)", () => {
  let q1 = "";

  it("closing a period locks the envelopes that overlap it; a draft on one is 423 (done-when)", async () => {
    expect(await status("emea")).toBe("PENDING");
    const res = await close("2026-Q1");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    q1 = String(res.body["id"]);
    expect(res.body).toMatchObject({ status: "closed", lockedEnvelopes: 2, period: { key: "2026-Q1", kind: "quarter", start: "2026-01-01", end: "2026-03-31" } });
    // D-1 (audit T-12): the closure records which "budget" basis its report used.
    expect(res.body["basis"]).toEqual({ budget: "live_leaves", note: expect.stringContaining("holdings") });
    expect([await status("latam"), await status("emea"), await status("apac")]).toEqual(["LOCKED", "LOCKED", "APPROVED"]);

    const latam = env["latam"]?.id ?? "";
    const draft = await call(planner, "PATCH", `/envelopes/${latam}/draft`, { amount: "650.00", basedOnVersionId: await head("latam") });
    expect(draft.status, JSON.stringify(draft.body)).toBe(423);
    expect(draft.body).toMatchObject({ code: "LOCKED" });
    expect((await call(planner, "PATCH", `/envelopes/${env["apac"]?.id ?? ""}/draft`, { amount: "55.00", basedOnVersionId: await head("apac") })).status).toBe(200);
  });

  it("the pending request on a locked envelope cannot be decided or withdrawn", async () => {
    const [request] = await asAdmin((tx) => tx.approvalRequest.findMany({ where: { workspaceId: ws, status: "PENDING" } }));
    expect(request).toBeDefined();
    expect((await call(approver, "POST", `/approvals/${request?.id}/decisions`, { decision: "approve" })).status).toBe(423);
    expect((await call(planner, "POST", `/approvals/${request?.id}/withdraw`, {})).status).toBe(423);
  });

  it("writes every template's rows for the period and each month; the report is the stored summary", async () => {
    const table = `closure_${q1.replace(/-/g, "")}`;
    const rows = sink.tables.get(table) ?? [];
    expect(rows.length).toBeGreaterThan(0);
    const total = rows.filter((r) => r.grain === "total").map((r) => [r.node_path, r.budget, r.actual, r.leaf_count]);
    expect(total).toEqual([
      // The pending envelope has no approved budget yet (the planner's rule): its budget is null.
      ["", "600.00", "140.50", 2],
      ["emea", null, "0.00", 1],
      ["latam", "600.00", "140.50", 1],
    ]);
    expect(rows.filter((r) => r.grain === "month" && r.node_path === "latam").map((r) => [r.month, r.actual, r.budget])).toEqual([
      ["2026-01-01", "100.00", null],
      ["2026-02-01", "40.50", null],
      ["2026-03-01", "0.00", null],
    ]);
    const report = await call(finance, "GET", `/closures/${q1}/report`);
    expect(report.status).toBe(200);
    expect(report.body["summary"]).toMatchObject({ lockedEnvelopes: 2, rows: rows.length, totals: { budget: "600.00", actual: "140.50", variance: "-459.50" }, months: [{ month: "2026-01-01", actual: "100.00" }, { month: "2026-02-01", actual: "40.50" }, { month: "2026-03-01", actual: "0.00" }], basis: { budget: "live_leaves" } });
    // D-1: the API view (not just the raw stored summary) also carries the basis.
    expect((report.body["closure"] as Record<string, unknown>)["basis"]).toEqual({ budget: "live_leaves", note: expect.any(String) });
    // Two transactions (W3-1): `closure.started` + `period.closing` before the sink, then exactly one
    // `closure.created` + `period.closed` once the rows are written.
    expect(await auditsOf(q1)).toEqual(["closure.created", "closure.started"]);
    expect(await topicsOf(q1)).toEqual(["period.closed", "period.closing"]);
  });

  it("refuses a second close, an unfinished period and a non-finance caller", async () => {
    expect((await close("2026-Q1")).status).toBe(409);
    expect((await close("FY2026")).status).toBe(409);
    expect((await close("2026-02", planner)).status).toBe(403);
  });

  it("a month closed inside the quarter keeps its envelopes locked until both are restated", async () => {
    const feb = await close("2026-02");
    expect(feb.status, JSON.stringify(feb.body)).toBe(201);
    expect((await call(admin, "POST", `/closures/${q1}/restate`, {})).status).toBe(422);
    expect((await call(finance, "POST", `/closures/${q1}/restate`, { reason: "late invoices" })).status).toBe(403);
    const restated = await call(admin, "POST", `/closures/${q1}/restate`, { reason: "Late January invoices" });
    expect(restated.status, JSON.stringify(restated.body)).toBe(201);
    expect(restated.body).toMatchObject({ status: "restated", unlockedEnvelopes: 0 });
    expect(await status("latam")).toBe("LOCKED"); // 2026-02 still covers it
    const again = await call(admin, "POST", `/closures/${String(feb.body["id"])}/restate`, { reason: "Reopen February too" });
    expect(again.body).toMatchObject({ unlockedEnvelopes: 2 });
    expect([await status("latam"), await status("emea")]).toEqual(["APPROVED", "PENDING"]);
    const [audit] = await asAdmin((tx) => tx.$queryRawUnsafe<Array<{ reason: string }>>(`SELECT reason FROM audit_event WHERE entity_type = 'period_closure' AND entity_id = $1::uuid AND action = 'closure.restated'`, q1));
    expect(audit?.reason).toBe("Late January invoices");
    expect((await call(admin, "POST", `/closures/${q1}/restate`, { reason: "twice" })).status).toBe(409);
  });

  it("after a restatement edits work again, and the next close of the period writes a new table named by its closure", async () => {
    expect((await call(planner, "PATCH", `/envelopes/${env["latam"]?.id ?? ""}/draft`, { amount: "650.00", basedOnVersionId: await head("latam") })).status).toBe(200);
    const res = await close("2026-Q1");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body["table"]).toBe(`closures.closure_${String(res.body["id"]).replace(/-/g, "")}`);
    expect(sink.tables.has(`closure_${q1.replace(/-/g, "")}`)).toBe(true);
    const list = await call(finance, "GET", `/workspaces/${ws}/closures`);
    expect((list.body as unknown as Array<{ period: { key: string }; status: string }>).map((c) => [c.period.key, c.status])).toEqual([
      ["2026-Q1", "closed"],
      ["2026-02", "restated"],
      ["2026-Q1", "restated"],
    ]);
  });
});

describe("two-phase close (W3-1, audit I-4)", () => {
  it("a sink failure after the table was created leaves a failed closure with its error, unlocks the envelopes, and the next close succeeds with a new table", async () => {
    const before = await status("apac");
    const original = sink.write;
    let partial = "";
    sink.write = async (table) => {
      partial = table;
      sink.tables.set(table, []); // createTable went through, then the insert failed
      throw new Error("insertAll: quota exceeded");
    };
    let res: Res;
    try {
      res = await close("2025-Q4");
    } finally {
      sink.write = original;
    }
    expect(res.status, JSON.stringify(res.body)).toBe(503);
    expect(res.body).toMatchObject({ code: "UNAVAILABLE" });
    const failed = await asAdmin((tx) => tx.periodClosure.findFirstOrThrow({ where: { workspaceId: ws, bqTable: partial } }));
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("quota exceeded");
    expect(await status("apac")).toBe(before);
    expect(await auditsOf(failed.id)).toEqual(["closure.failed", "closure.started"]);
    expect(await topicsOf(failed.id)).toEqual(["period.closing", "period.closure_failed"]);

    const again = await close("2025-Q4");
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body["table"]).not.toBe(`closures.${partial}`);
    expect(again.body["table"]).toBe(`closures.closure_${String(again.body["id"]).replace(/-/g, "")}`);
    expect(sink.tables.get(String(again.body["table"]).slice("closures.".length))?.length).toBeGreaterThan(0);
    expect(await status("apac")).toBe("LOCKED");
    const list = (await call(finance, "GET", `/workspaces/${ws}/closures`)).body as unknown as Array<{ id: string; status: string; error: string | null }>;
    expect(list.find((c) => c.id === failed.id)).toMatchObject({ status: "failed", error: expect.stringContaining("quota exceeded") });

    // Reopen the quarter for the next test.
    expect((await call(admin, "POST", `/closures/${String(again.body["id"])}/restate`, { reason: "reopen for W3-1" })).status).toBe(201);
    expect(await status("apac")).toBe(before);
  });

  it("while the sink writes: a concurrent close is 409, other writes go through, restate and an early abandon are 409; a stale close is abandoned and its envelopes unlocked", { timeout: 120_000 }, async () => {
    const before = await status("apac");
    const period = await asAdmin((tx) => tx.fiscalPeriod.findFirstOrThrow({ where: { workspaceId: ws, key: "2025-Q4" } }));
    const g = gate();
    const original = sink.write;
    sink.write = async (table, rows, opts) => {
      await g.wait;
      return original.call(sink, table, rows, opts);
    };
    try {
      const attempts = [close("2025-Q4"), close("2025-Q4")];
      // (b) one attempt is refused while the other waits on the sink.
      // Generous bounds: before W3-1 both waits were unbounded (the gate never opens), so CI load cannot fake a pass.
      const first = await within(Promise.race(attempts.map((p, i) => p.then((r) => ({ i, r })))), 30_000);
      expect(first).not.toBe("timeout");
      if (first === "timeout") return;
      expect(first.r.status, JSON.stringify(first.r.body)).toBe(409);
      const winner = attempts[1 - first.i] as Promise<Res>;
      const open = await asAdmin((tx) => tx.periodClosure.findMany({ where: { workspaceId: ws, periodId: period.id, status: { in: ["closing", "closed"] } } }));
      expect(open.map((c) => c.status)).toEqual(["closing"]);
      const closing = open[0]?.id ?? "";
      expect(await status("apac")).toBe("LOCKED");

      // (f) the workspace row is not held during sink.write: another write in the workspace completes.
      const created = await within(
        call(planner, "POST", `/workspaces/${ws}/envelopes`, { name: "APAC 2027", dimensionValues: { region: "apac" }, startDate: "2027-01-01", endDate: "2027-12-31", currency: "USD", amount: "10.00", ownerId: planner.id }),
        30_000,
      );
      expect(created === "timeout" ? "timeout" : created.status).toBe(201);

      // (c) a closing closure cannot be restated; a fresh one cannot be abandoned.
      const restate = await call(admin, "POST", `/closures/${closing}/restate`, { reason: "too early" });
      expect(restate.status).toBe(409);
      expect(String(restate.body["message"])).toMatch(/in progress/);
      expect((await call(finance, "POST", `/closures/${closing}/abandon`, {})).status).toBe(409);

      // (d) after 15 minutes it is stale: abandon fails it and gives the envelopes back.
      await asAdmin((tx) => tx.periodClosure.update({ where: { id: closing }, data: { closedAt: new Date(Date.now() - 20 * 60_000) } }));
      expect((await call(planner, "POST", `/closures/${closing}/abandon`, {})).status).toBe(403);
      const abandoned = await call(finance, "POST", `/closures/${closing}/abandon`, {});
      expect(abandoned.status, JSON.stringify(abandoned.body)).toBe(201);
      expect(abandoned.body).toMatchObject({ id: closing, status: "failed", error: expect.stringContaining("Abandoned") });
      expect(await status("apac")).toBe(before);
      expect(await auditsOf(closing)).toEqual(["closure.abandoned", "closure.started"]);
      expect(await topicsOf(closing)).toEqual(["period.closing", "period.closure_failed"]);

      // The abandoned attempt finishes writing; it does not resurrect the closure.
      g.release();
      const late = await winner;
      expect(late.status, JSON.stringify(late.body)).toBe(409);
      expect((await asAdmin((tx) => tx.periodClosure.findUniqueOrThrow({ where: { id: closing } }))).status).toBe("failed");
      expect(await status("apac")).toBe(before);
    } finally {
      g.release();
      sink.write = original;
    }
  });
});
