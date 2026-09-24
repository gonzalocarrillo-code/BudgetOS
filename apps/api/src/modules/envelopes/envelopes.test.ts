import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerDb, startHarness, testUser, type Harness, type TestUser } from "../../test-support/harness.js";

/**
 * T-010 done-when: a conflicting draft edit returns 409 with currentVersionId. Also: every write
 * emits exactly one audit_event and one outbox row, approved amounts are never updated in place,
 * phasing / restore / metadata (rowVersion) behave, closed periods are 423.
 */

const owner = ownerDb();
let h: Harness;

const orgId = randomUUID();
const ws = randomUUID();
const otherWs = randomUUID();
const planner = testUser("planner", randomUUID());
const viewer = testUser("viewer", randomUUID());
const scopedOwner = testUser("scoped-owner", randomUUID());
const orgAdmin = testUser("org-admin", randomUUID());
const region = randomUUID();
const platform = randomUUID();
const TEST_CCY = "XTS"; // ISO 4217 code reserved for testing

const tok = (u: TestUser) => h.mint(u);
const X = { "x-workspace-id": ws };
let seq = 0;
const rid = () => `t010-${++seq}-${orgId}`;

async function auditFor(requestId: string, envelopeId: string): Promise<Array<{ action: string }>> {
  return owner.$queryRawUnsafe(`SELECT action FROM audit_event WHERE request_id = $1 AND entity_id = $2::uuid`, requestId, envelopeId);
}
async function outboxFor(envelopeId: string): Promise<number> {
  const rows = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*) AS n FROM outbox WHERE workspace_id = $1::uuid AND topic = 'budget.changed' AND payload->>'envelopeId' = $2`,
    ws,
    envelopeId,
  );
  return Number(rows[0]?.n ?? 0);
}
async function dataVersion(): Promise<number> {
  const w = await owner.workspace.findUniqueOrThrow({ where: { id: ws } });
  return Number((w.settings as { dataVersion?: number }).dataVersion ?? 0);
}

/** Runs a write and asserts it produced exactly one audit_event (by request id) and one outbox row. */
async function oneAuditOneOutbox(envelopeId: string | null, action: string, write: (requestId: string) => Promise<{ status: number; body: Record<string, unknown> }>) {
  const requestId = rid();
  const beforeOutbox = envelopeId ? await outboxFor(envelopeId) : 0;
  const beforeVersion = await dataVersion();
  const res = await write(requestId);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  const id = envelopeId ?? String(res.body["id"]);
  expect((await auditFor(requestId, id)).map((a) => a.action)).toEqual([action]);
  expect((await outboxFor(id)) - beforeOutbox).toBe(1);
  expect(await dataVersion()).toBe(beforeVersion + 1);
  return res;
}

const envelopeBody = (over: Record<string, unknown> = {}) => ({
  name: `Env ${randomUUID().slice(0, 8)}`,
  dimensionValues: { region: "br", platform: "meta" },
  startDate: "2026-10-01",
  endDate: "2026-12-31",
  currency: "USD",
  ...over,
});
const q4 = (a: string, b: string, c: string) => [
  { month: "2026-10-01", amount: a },
  { month: "2026-11-01", amount: b },
  { month: "2026-12-01", amount: c },
];

async function create(user: TestUser, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return h.call("POST", `/api/v1/workspaces/${ws}/envelopes`, await tok(user), { body, headers });
}
async function get(id: string, user: TestUser = planner) {
  return h.call("GET", `/api/v1/envelopes/${id}`, await tok(user), { headers: X });
}
async function draft(id: string, body: Record<string, unknown>, user: TestUser = planner, requestId = rid()) {
  return h.call("PATCH", `/api/v1/envelopes/${id}/draft`, await tok(user), { headers: { ...X, "x-request-id": requestId }, body });
}

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "t010" } });
  await owner.workspace.createMany({
    data: [
      { id: ws, orgId, slug: `t010-${ws}`, name: "T-010", reportingCurrency: "USD" },
      { id: otherWs, orgId, slug: `t010-${otherWs}`, name: "T-010 other", reportingCurrency: "USD" },
    ],
  });
  await owner.user.createMany({
    data: [planner, viewer, scopedOwner, orgAdmin].map((u) => ({ id: u.id, orgId, email: u.email, name: u.email, googleSub: `g-${u.sub}` })),
  });
  const latamScope = { logic: "and", children: [{ field: { kind: "dimension", key: "region" }, op: "descends_from", value: "latam" }] };
  await owner.roleAssignment.createMany({
    data: [
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: planner.id, role: "PLANNER", createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: viewer.id, role: "VIEWER", createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: scopedOwner.id, role: "BUDGET_OWNER", scope: latamScope, createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: null, principalType: "user", principalId: orgAdmin.id, role: "ORG_ADMIN", createdBy: orgAdmin.id },
    ],
  });
  await owner.$executeRawUnsafe(
    `INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by) VALUES ($1::uuid, $3::uuid, NULL, 'region', 'Region', 'ENUM', $4::uuid), ($2::uuid, $3::uuid, NULL, 'platform', 'Platform', 'ENUM', $4::uuid)`,
    region,
    platform,
    orgId,
    orgAdmin.id,
  );
  const ids: Record<string, string> = {};
  for (const [code, dim, parent] of [["latam", region, null], ["br", region, "latam"], ["emea", region, null], ["de", region, "emea"], ["meta", platform, null], ["google", platform, null]] as const) {
    ids[code] = randomUUID();
    await owner.$executeRawUnsafe(
      `INSERT INTO dimension_value (id, dimension_id, code, label, parent_value_id) VALUES ($1::uuid, $2::uuid, $3, $3, $4::uuid)`,
      ids[code],
      dim,
      code,
      parent ? ids[parent] : null,
    );
  }
  h = await startHarness();
}, 60_000);

afterAll(async () => {
  await h?.close();
  const envs = `(SELECT id FROM envelope WHERE workspace_id = ANY($1::uuid[]))`;
  const wss = [ws, otherWs];
  await owner.$executeRawUnsafe(`DELETE FROM envelope_phasing WHERE version_id IN (SELECT id FROM envelope_version WHERE envelope_id IN ${envs})`, wss);
  await owner.$executeRawUnsafe(`DELETE FROM envelope_version WHERE envelope_id IN ${envs}`, wss);
  await owner.$executeRawUnsafe(`DELETE FROM envelope_dimension WHERE envelope_id IN ${envs}`, wss);
  await owner.$executeRawUnsafe(`DELETE FROM envelope WHERE workspace_id = ANY($1::uuid[])`, wss);
  await owner.$executeRawUnsafe(`DELETE FROM outbox WHERE workspace_id = ANY($1::uuid[])`, wss);
  await owner.$executeRawUnsafe(`DELETE FROM dimension_value WHERE dimension_id IN ($1::uuid, $2::uuid)`, region, platform);
  await owner.$executeRawUnsafe(`DELETE FROM dimension WHERE org_id = $1::uuid`, orgId);
  await owner.$executeRawUnsafe(`DELETE FROM fx_rate WHERE base = $1`, TEST_CCY);
  await owner.roleAssignment.deleteMany({ where: { principalId: { in: [planner.id, viewer.id, scopedOwner.id, orgAdmin.id] } } });
  await owner.user.deleteMany({ where: { orgId } });
  await owner.workspace.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await owner.$disconnect();
});

describe("create", () => {
  it("creates the envelope, its dimension rows and a v1 draft; one audit_event + one outbox row", async () => {
    const res = await oneAuditOneOutbox(null, "envelope.created", async (requestId) =>
      create(planner, envelopeBody({ amount: "1200.00", phasing: q4("400", "400", "400") }), { "x-request-id": requestId }),
    );
    expect(res.status).toBe(201);
    const draftV = res.body["draft"] as { versionNo: number; amount: string; amountReporting: string; status: string; phasing: unknown[] };
    expect(draftV).toMatchObject({ versionNo: 1, amount: "1200.00", amountReporting: "1200.00", status: "DRAFT" });
    expect(draftV.phasing).toHaveLength(3);
    expect(res.body["status"]).toBe("DRAFT");
    expect(res.body["currentVersionId"]).toBeNull();
    const dims = await owner.envelopeDimension.count({ where: { envelopeId: String(res.body["id"]) } });
    expect(dims).toBe(2);
  });

  it("rejects a tuple the registry does not allow, and writes nothing", async () => {
    const before = await owner.envelope.count({ where: { workspaceId: ws } });
    expect((await create(planner, envelopeBody({ dimensionValues: { region: "xx" } }))).status).toBe(422);
    expect((await create(planner, envelopeBody({ dimensionValues: { country: "br" } }))).status).toBe(422);
    expect((await create(planner, envelopeBody({ endDate: "2026-09-01" }))).status).toBeGreaterThanOrEqual(400);
    expect((await create(planner, envelopeBody({ amount: "10.123" }))).status).toBeGreaterThanOrEqual(400);
    expect(await owner.envelope.count({ where: { workspaceId: ws } })).toBe(before);
  });

  it("converts into the reporting currency with a stored fx_rate, and refuses to guess without one", async () => {
    expect((await create(planner, envelopeBody({ currency: TEST_CCY, amount: "100.00" }))).status).toBe(422);
    await owner.fxRate.create({ data: { id: randomUUID(), base: TEST_CCY, quote: "USD", rate: "1.25", asOfDate: new Date("2020-01-01"), source: "test" } });
    const res = await create(planner, envelopeBody({ currency: TEST_CCY, amount: "100.10" }));
    expect(res.status).toBe(201);
    const v = res.body["draft"] as { amount: string; amountReporting: string; fxRateId: string | null };
    expect(v.amount).toBe("100.10");
    expect(v.amountReporting).toBe("125.13"); // 125.125 → 2 dp, half-up
    expect(v.fxRateId).not.toBeNull();
  });

  it("scope: a LATAM-scoped budget owner can create under LATAM only", async () => {
    expect((await create(scopedOwner, envelopeBody({ dimensionValues: { region: "de" } }))).status).toBe(403);
    expect((await create(scopedOwner, envelopeBody({ dimensionValues: { region: "br" } }))).status).toBe(201);
  });
});

describe("draft versions and optimistic concurrency", () => {
  it("a stale basedOnVersionId returns 409 with currentVersionId (T-010 done-when)", async () => {
    const env = await create(planner, envelopeBody({ amount: "1000.00" }));
    const id = String(env.body["id"]);
    const v1 = String(env.body["draftVersionId"]);

    const stale = await draft(id, { amount: "1100.00", basedOnVersionId: null });
    expect(stale.status).toBe(409);
    expect(stale.body["code"]).toBe("CONFLICT");
    expect((stale.body["details"] as { currentVersionId: string }).currentVersionId).toBe(v1);

    const ok = await oneAuditOneOutbox(id, "envelope.version.created", (requestId) => draft(id, { amount: "1100.00", basedOnVersionId: v1 }, planner, requestId));
    expect(ok.body).toMatchObject({ versionNo: 2, amount: "1100.00", status: "DRAFT" });
    const versions = (await h.call("GET", `/api/v1/envelopes/${id}/versions`, await tok(viewer), { headers: X })).body as unknown as Array<{ versionNo: number; status: string }>;
    expect(versions.map((v) => [v.versionNo, v.status])).toEqual([
      [2, "DRAFT"],
      [1, "SUPERSEDED"],
    ]);
  });

  it("two concurrent edits on the same base: one wins, the other gets 409", async () => {
    const env = await create(planner, envelopeBody({ amount: "500.00" }));
    const id = String(env.body["id"]);
    const v1 = String(env.body["draftVersionId"]);
    const results = await Promise.all([draft(id, { amount: "600.00", basedOnVersionId: v1 }), draft(id, { amount: "700.00", basedOnVersionId: v1 })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = results.find((r) => r.status === 409)!;
    const winner = results.find((r) => r.status === 200)!;
    expect((loser.body["details"] as { currentVersionId: string }).currentVersionId).toBe(winner.body["id"]);
  });

  it("never updates an approved amount in place", async () => {
    const env = await create(planner, envelopeBody());
    const id = String(env.body["id"]);
    // Approval is T-011; the fixture writes the approved version directly.
    const approvedId = randomUUID();
    const approvedAt = new Date("2026-09-01T12:00:00Z");
    await owner.envelopeVersion.create({
      data: { id: approvedId, envelopeId: id, versionNo: 1, amount: "5000.00", amountReporting: "5000.00", status: "APPROVED", approvedAt, createdBy: planner.id },
    });
    await owner.envelope.update({ where: { id }, data: { currentVersionId: approvedId, status: "APPROVED" } });

    const res = await draft(id, { amount: "6000.00", basedOnVersionId: approvedId });
    expect(res.status).toBe(200);
    expect(res.body["basedOnVersionId"]).toBe(approvedId);
    const approved = await owner.envelopeVersion.findUniqueOrThrow({ where: { id: approvedId } });
    expect(approved.amount.toFixed(2)).toBe("5000.00");
    expect(approved.status).toBe("APPROVED");
    expect(approved.approvedAt?.toISOString()).toBe(approvedAt.toISOString());
    const after = await get(id);
    expect(after.body).toMatchObject({ status: "APPROVED", currentVersionId: approvedId });
    expect((after.body["current"] as { amount: string }).amount).toBe("5000.00");
    expect((after.body["draft"] as { amount: string }).amount).toBe("6000.00");
  });

  it("a draft awaiting approval cannot be edited", async () => {
    const env = await create(planner, envelopeBody({ amount: "10.00" }));
    const id = String(env.body["id"]);
    const v1 = String(env.body["draftVersionId"]);
    await owner.envelopeVersion.update({ where: { id: v1 }, data: { status: "PENDING" } });
    const res = await draft(id, { amount: "20.00", basedOnVersionId: v1 });
    expect(res.status).toBe(409);
    expect((res.body["details"] as { currentVersionId: string }).currentVersionId).toBe(v1);
  });
});

describe("phasing", () => {
  it("re-phases the head amount into a new draft; the monthly split must be valid", async () => {
    const env = await create(planner, envelopeBody({ amount: "900.00", phasing: q4("300", "300", "300") }));
    const id = String(env.body["id"]);
    const v1 = String(env.body["draftVersionId"]);
    const url = `/api/v1/envelopes/${id}/phasing`;
    const t = await tok(planner);
    const bad = async (phasing: unknown) => (await h.call("PATCH", url, t, { headers: X, body: { phasing, basedOnVersionId: v1 } })).status;
    expect(await bad(q4("300", "300", "301"))).toBe(422); // sum ≠ amount
    expect(await bad([{ month: "2026-10-15", amount: "900" }])).toBe(422); // not first of month
    expect(await bad([{ month: "2027-01-01", amount: "900" }])).toBe(422); // outside the envelope
    expect(await bad([{ month: "2026-10-01", amount: "450" }, { month: "2026-10-01", amount: "450" }])).toBe(422); // repeated

    const res = await oneAuditOneOutbox(id, "envelope.phasing.changed", (requestId) =>
      h.call("PATCH", url, t, { headers: { ...X, "x-request-id": requestId }, body: { phasing: q4("600", "200", "100"), basedOnVersionId: v1 } }),
    );
    expect(res.body).toMatchObject({ versionNo: 2, amount: "900.00" });
    expect((res.body["phasing"] as Array<{ amount: string }>).map((p) => p.amount)).toEqual(["600.00", "200.00", "100.00"]);
    const old = await owner.envelopePhasing.findMany({ where: { versionId: v1 }, orderBy: { month: "asc" } });
    expect(old.map((p) => p.amount.toFixed(2))).toEqual(["300.00", "300.00", "300.00"]);
  });
});

describe("restore", () => {
  it("copies a past version's amount and phasing into a new draft", async () => {
    const env = await create(planner, envelopeBody({ amount: "300.00", phasing: q4("100", "100", "100") }));
    const id = String(env.body["id"]);
    const v1 = String(env.body["draftVersionId"]);
    const v2 = String((await draft(id, { amount: "999.00", basedOnVersionId: v1 })).body["id"]);
    const url = `/api/v1/envelopes/${id}/restore/${v1}`;
    const t = await tok(planner);
    expect((await h.call("POST", url, t, { headers: X, body: { basedOnVersionId: v1 } })).status).toBe(409);
    expect((await h.call("POST", `/api/v1/envelopes/${id}/restore/${randomUUID()}`, t, { headers: X, body: { basedOnVersionId: v2 } })).status).toBe(404);

    const res = await oneAuditOneOutbox(id, "envelope.version.restored", (requestId) =>
      h.call("POST", url, t, { headers: { ...X, "x-request-id": requestId }, body: { basedOnVersionId: v2 } }),
    );
    expect(res.body).toMatchObject({ versionNo: 3, amount: "300.00", rationale: "Restored from v1", status: "DRAFT" });
    expect((res.body["phasing"] as unknown[]).length).toBe(3);
    const statuses = await owner.envelopeVersion.findMany({ where: { envelopeId: id }, orderBy: { versionNo: "asc" }, select: { status: true } });
    expect(statuses.map((s) => s.status)).toEqual(["SUPERSEDED", "SUPERSEDED", "DRAFT"]);
  });
});

describe("metadata edit with rowVersion", () => {
  it("applies with the current rowVersion; a stale one is 409 with currentRowVersion and currentVersionId", async () => {
    const env = await create(planner, envelopeBody({ amount: "50.00" }));
    const id = String(env.body["id"]);
    const rowVersion = Number(env.body["rowVersion"]);
    const url = `/api/v1/envelopes/${id}`;
    const t = await tok(planner);
    const res = await oneAuditOneOutbox(id, "envelope.updated", (requestId) =>
      h.call("PATCH", url, t, { headers: { ...X, "x-request-id": requestId }, body: { rowVersion, name: "Renamed", endDate: "2027-01-31" } }),
    );
    expect(res.body).toMatchObject({ name: "Renamed", endDate: "2027-01-31", rowVersion: rowVersion + 1 });

    const stale = await h.call("PATCH", url, t, { headers: X, body: { rowVersion, name: "Again" } });
    expect(stale.status).toBe(409);
    expect(stale.body["details"]).toEqual({ currentRowVersion: rowVersion + 1, currentVersionId: env.body["draftVersionId"] });
    // Amounts and tuples are not metadata.
    expect((await h.call("PATCH", url, t, { headers: X, body: { rowVersion: rowVersion + 1, amount: "1" } })).status).toBeGreaterThanOrEqual(400);
    expect((await h.call("PATCH", url, t, { headers: X, body: { rowVersion: rowVersion + 1, startDate: "2027-06-01" } })).status).toBe(422);
  });
});

describe("closed periods and tenancy", () => {
  it("every write on a LOCKED envelope is 423", async () => {
    const env = await create(planner, envelopeBody({ amount: "10.00" }));
    const id = String(env.body["id"]);
    const v1 = String(env.body["draftVersionId"]);
    await owner.envelope.update({ where: { id }, data: { status: "LOCKED" } });
    const t = await tok(planner);
    expect((await draft(id, { amount: "11.00", basedOnVersionId: v1 })).status).toBe(423);
    expect((await h.call("PATCH", `/api/v1/envelopes/${id}/phasing`, t, { headers: X, body: { phasing: q4("10", "0", "0"), basedOnVersionId: v1 } })).status).toBe(423);
    expect((await h.call("POST", `/api/v1/envelopes/${id}/restore/${v1}`, t, { headers: X, body: { basedOnVersionId: v1 } })).status).toBe(423);
    expect((await h.call("PATCH", `/api/v1/envelopes/${id}`, t, { headers: X, body: { rowVersion: 2, name: "x" } })).status).toBe(423);
  });

  it("scope applies to reads and edits of existing envelopes", async () => {
    const emea = await create(planner, envelopeBody({ dimensionValues: { region: "de" }, amount: "1.00" }));
    const id = String(emea.body["id"]);
    expect((await get(id, scopedOwner)).status).toBe(403);
    expect((await draft(id, { amount: "2.00", basedOnVersionId: String(emea.body["draftVersionId"]) }, scopedOwner)).status).toBe(403);
    expect((await get(id, viewer)).status).toBe(200);
  });

  it("an envelope id is invisible from another workspace", async () => {
    const env = await create(planner, envelopeBody());
    const res = await h.call("GET", `/api/v1/envelopes/${String(env.body["id"])}`, await tok(orgAdmin), { headers: { "x-workspace-id": otherWs } });
    expect(res.status).toBe(404);
  });
});
