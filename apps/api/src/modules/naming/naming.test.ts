import { randomUUID } from "node:crypto";
import { asOrgAdmin, type Tx } from "@budget/db";
import { deleteWorkspaceForTests } from "@budget/workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerDb, startHarness, testUser, type Harness, type TestUser } from "../../test-support/harness.js";

/**
 * T-036 done-when (spec §24.4): the preview renders 5 samples. Templates: one active per kind; a
 * display template renames every envelope (the grid shows it), a match_key template keys them; each
 * write is audited and sends naming.changed; a new envelope is named on create.
 */

const owner = ownerDb();
let h: Harness;
const orgId = randomUUID();
const ws = randomUUID();
const admin = testUser("t036-admin", randomUUID());
const planner = testUser("t036-planner", randomUUID());
const X = { "x-workspace-id": ws };
let seq = 0;
const rid = () => `t036-${++seq}-${orgId}`;
const ids: string[] = [];

async function call(user: TestUser, method: "GET" | "POST" | "PATCH", url: string, body?: unknown, requestId = rid()) {
  return h.call(method, `/api/v1${url}`, await h.mint(user), { headers: { ...X, "x-request-id": requestId }, ...(body === undefined ? {} : { body }) });
}
// W0-6: the owner has no BYPASSRLS; every raw/Prisma call against the workspace-scoped tables
// below needs the org-admin tenant context real writes get from withTenant.
const asAdmin = <T,>(fn: (tx: Tx) => Promise<T>) => asOrgAdmin(owner, fn, orgId);
const display = { kind: "display", chips: [{ type: "dimension", key: "country" }, { type: "separator", value: " " }, { type: "separator", value: "·" }, { type: "separator", value: " " }, { type: "dimension", key: "platform" }, { type: "separator", value: " " }, { type: "period", format: "yyyy-QQ" }] };
const matchKey = { kind: "match_key", chips: [{ type: "dimension", key: "country" }, { type: "separator", value: "_" }, { type: "dimension", key: "platform" }], casing: "lower" };

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "t036" } });
  // W0-6: workspace has no owner_bootstrap policy; it needs the org-admin tenant context real
  // writes get from withTenant, with the real org id for its exact org_id match.
  await asAdmin((tx) => tx.workspace.create({ data: { id: ws, orgId, slug: `t036-${ws}`, name: "T-036", reportingCurrency: "USD" } }));
  await owner.user.createMany({ data: [admin, planner].map((u) => ({ id: u.id, orgId, email: u.email, name: `Name ${u.sub}`, googleSub: `g-${u.sub}` })) });
  await owner.roleAssignment.createMany({
    data: [
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: admin.id, role: "WORKSPACE_ADMIN", scope: {}, createdBy: admin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: planner.id, role: "PLANNER", scope: {}, createdBy: admin.id },
    ],
  });
  h = await startHarness();
  for (const [key, label, values] of [["country", "Country", [["BR", "Brazil"], ["MX", "Mexico"], ["AR", "Argentina"]]], ["platform", "Platform", [["meta", "Meta"], ["google_ads", "Google Ads"]]]] as const) {
    const d = await call(admin, "POST", `/workspaces/${ws}/dimensions`, { key, label, dataType: "ENUM", icon: "lucide:tag", workspaceId: ws });
    await call(admin, "POST", `/dimensions/${String(d.body["id"])}/values`, { values: values.map(([code, l]) => ({ code, label: l })) });
  }
  for (const [country, platform] of [["BR", "meta"], ["BR", "google_ads"], ["MX", "meta"], ["MX", "google_ads"], ["AR", "meta"], ["AR", "google_ads"]]) {
    const e = await call(planner, "POST", `/workspaces/${ws}/envelopes`, { name: `${country} ${platform}`, dimensionValues: { country, platform }, startDate: "2026-10-01", endDate: "2026-12-31", currency: "USD" });
    expect(e.status, JSON.stringify(e.body)).toBe(201);
    ids.push(String(e.body["id"]));
  }
}, 60_000);

afterAll(async () => {
  await h?.close();
  // W3-11 (audit I-32): deletes every row that FKs to this workspace (and the workspace row
  // itself), in the same order `purgeWorkspace` validates against production.
  // W0-6: the owner has no BYPASSRLS; pass orgId so deleteWorkspaceForTests runs under org-admin
  // tenant context.
  await deleteWorkspaceForTests(owner, ws, orgId);
  await asAdmin(async (tx) => {
    await tx.$executeRawUnsafe(`DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`, orgId);
    await tx.$executeRawUnsafe(`DELETE FROM dimension WHERE org_id = $1::uuid`, orgId);
  });
  await owner.user.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await owner.$disconnect();
});

describe("naming templates (T-036)", () => {
  it("preview renders 5 samples (done-when), labels for display and codes for a match key; nothing saved", async () => {
    const res = await call(admin, "POST", "/naming-templates/preview", { template: display });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const previews = res.body["previews"] as Array<{ envelopeId: string; rendered: string }>;
    expect(previews).toHaveLength(5);
    expect(previews.map((p) => p.rendered)).toContain("Brazil · Meta 2026-Q4");
    const keyed = await call(admin, "POST", "/naming-templates/preview", { template: matchKey, sampleEnvelopeIds: [ids[1]] });
    expect(keyed.body["previews"]).toEqual([{ envelopeId: ids[1], name: "BR google_ads", rendered: "br_google_ads" }]);
    expect(await asAdmin((tx) => tx.namingTemplate.count({ where: { workspaceId: ws } }))).toBe(0);
    expect((await call(planner, "POST", "/naming-templates/preview", { template: display })).status).toBe(403);
  });

  it("a display template renames every envelope at once; audited, naming.changed; the Explorer shows the display name", async () => {
    const requestId = rid();
    const res = await call(admin, "POST", `/workspaces/${ws}/naming-templates`, display, requestId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ kind: "display", version: 1, isActive: true, recomputed: 6, queued: false });
    const audits = await asAdmin((tx) => tx.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_event WHERE request_id = $1`, requestId));
    expect(audits.map((a) => a.action)).toEqual(["naming.created"]);
    expect(await asAdmin((tx) => tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE workspace_id = $1::uuid AND topic = 'naming.changed'`, ws))).toEqual([{ n: 1n }]);
    const env = await call(planner, "GET", `/envelopes/${ids[0]}`);
    expect(env.body).toMatchObject({ name: "BR meta", displayName: "Brazil · Meta 2026-Q4" });
    const q = await call(planner, "POST", `/workspaces/${ws}/query`, { workspaceId: ws, period: { kind: "range", start: "2026-10-01", end: "2026-12-31" }, measures: ["budget"], sort: [{ key: "name", dir: "asc" }], limit: 10 });
    expect((q.body["rows"] as Array<{ path: string[] }>).map((r) => r.path.at(-1))).toContain("Mexico · Google Ads 2026-Q4");
  });

  it("one active per kind: a second match_key template retires the first; PATCH makes a new version; a new envelope is keyed on create", async () => {
    const first = await call(admin, "POST", `/workspaces/${ws}/naming-templates`, { ...matchKey, casing: "upper" });
    const second = await call(admin, "POST", `/workspaces/${ws}/naming-templates`, matchKey);
    expect((await asAdmin((tx) => tx.namingTemplate.findUniqueOrThrow({ where: { id: String(first.body["id"]) } }))).isActive).toBe(false);
    expect((await asAdmin((tx) => tx.envelope.findUniqueOrThrow({ where: { id: ids[2] as string } }))).matchKey).toBe("mx_meta");
    const patched = await call(admin, "PATCH", `/naming-templates/${String(second.body["id"])}`, { whitespace: "dash", chips: [...matchKey.chips, { type: "separator", value: " " }, { type: "text", value: "Q4" }] });
    expect(patched.body).toMatchObject({ version: 2, kind: "match_key" });
    expect((await asAdmin((tx) => tx.envelope.findUniqueOrThrow({ where: { id: ids[2] as string } }))).matchKey).toBe("mx_meta-q4");
    const created = await call(planner, "POST", `/workspaces/${ws}/envelopes`, { name: "AR extra", dimensionValues: { country: "AR" }, startDate: "2026-10-01", endDate: "2026-12-31", currency: "USD" });
    expect(await asAdmin((tx) => tx.envelope.findUniqueOrThrow({ where: { id: String(created.body["id"]) }, select: { matchKey: true, displayName: true } }))).toEqual({ matchKey: "ar_-q4", displayName: "Argentina ·  2026-Q4" });
    const list = (await call(planner, "GET", `/workspaces/${ws}/naming-templates`)).body as unknown as Array<{ kind: string; isActive: boolean }>;
    expect(list.filter((t) => t.isActive).map((t) => t.kind).sort()).toEqual(["display", "match_key"]);
  });

  it("refuses an unknown dimension and a planner", async () => {
    expect((await call(admin, "POST", `/workspaces/${ws}/naming-templates`, { kind: "display", chips: [{ type: "dimension", key: "nope_dim" }] })).status).toBe(422);
    expect((await call(planner, "POST", `/workspaces/${ws}/naming-templates`, display)).status).toBe(403);
  });
});
