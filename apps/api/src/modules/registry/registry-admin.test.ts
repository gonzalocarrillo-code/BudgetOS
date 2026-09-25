import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerDb, startHarness, testUser, type Harness, type TestUser } from "../../test-support/harness.js";

/**
 * T-031: what the registry admin UI needs from the API. The list carries each dimension's and
 * value's state (active, aliases, merged); a value moves under another with its whole subtree (the
 * path trigger only rewrites the moved row), never under itself; an uploaded icon is served back.
 */

const owner = ownerDb();
let h: Harness;
const orgId = randomUUID();
const ws = randomUUID();
const admin = testUser("t031-admin", randomUUID());
const viewer = testUser("t031-viewer", randomUUID());
const X = { "x-workspace-id": ws };
let seq = 0;
const rid = () => `t031-${++seq}-${orgId}`;

type Res = { status: number; body: Record<string, unknown> };
async function call(user: TestUser, method: "GET" | "POST" | "PATCH", url: string, body?: unknown, requestId = rid()): Promise<Res> {
  return h.call(method, `/api/v1${url}`, await h.mint(user), { headers: { ...X, "x-request-id": requestId }, ...(body === undefined ? {} : { body }) });
}
type Value = { id: string; code: string; path: string; parentValueId: string | null; isActive: boolean; aliases: string[]; mergedIntoId: string | null; externalIds: Record<string, string> };
type Dim = { id: string; key: string; isActive: boolean; description: string | null; values: Value[] };
const dims = async () => (await call(viewer, "GET", `/workspaces/${ws}/dimensions`)).body as unknown as Dim[];
const values = async (key: string) => new Map(((await dims()).find((d) => d.key === key)?.values ?? []).map((v) => [v.code, v]));

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "t031" } });
  await owner.workspace.create({ data: { id: ws, orgId, slug: `t031-${ws}`, name: "T-031", reportingCurrency: "USD" } });
  await owner.user.createMany({ data: [admin, viewer].map((u) => ({ id: u.id, orgId, email: u.email, name: `Name ${u.sub}`, googleSub: `g-${u.sub}` })) });
  await owner.roleAssignment.createMany({
    data: [
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: admin.id, role: "WORKSPACE_ADMIN", scope: {}, createdBy: admin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: viewer.id, role: "VIEWER", scope: {}, createdBy: admin.id },
    ],
  });
  h = await startHarness();
}, 60_000);

afterAll(async () => {
  await h?.close();
  await owner.$executeRawUnsafe(`DELETE FROM hierarchy_template WHERE workspace_id = $1::uuid`, ws);
  await owner.$executeRawUnsafe(`DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`, orgId);
  await owner.$executeRawUnsafe(`DELETE FROM dimension WHERE org_id = $1::uuid`, orgId);
  await owner.$executeRawUnsafe(`DELETE FROM outbox WHERE workspace_id = $1::uuid`, ws);
  await owner.roleAssignment.deleteMany({ where: { workspaceId: ws } });
  await owner.user.deleteMany({ where: { orgId } });
  await owner.workspace.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await owner.$disconnect();
});

describe("registry admin (T-031)", () => {
  it("a custom granularity with nested values; the list says what is active, aliased or merged", async () => {
    const created = await call(admin, "POST", `/workspaces/${ws}/dimensions`, { key: "market_tier", label: "Market tier", description: "Where a market sits", dataType: "ENUM", icon: "lucide:gem", workspaceId: ws });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = String(created.body["id"]);
    const added = await call(admin, "POST", `/dimensions/${id}/values`, {
      values: [
        { code: "tier1", label: "Tier 1" },
        { code: "tier1_core", label: "Core", parentCode: "tier1" },
        { code: "tier1_core_a", label: "Core A", parentCode: "tier1_core" },
        { code: "tier2", label: "Tier 2" },
        { code: "t2", label: "Tier two" },
      ],
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    await call(admin, "POST", `/values/${(await values("market_tier")).get("t2")?.id ?? ""}/merge`, { fromCode: "t2", intoCode: "tier2" });
    const d = (await dims()).find((x) => x.key === "market_tier");
    expect(d).toMatchObject({ isActive: true, description: "Where a market sits" });
    const v = new Map(d?.values.map((x) => [x.code, x]));
    expect(v.get("tier1_core_a")).toMatchObject({ path: "tier1.tier1_core.tier1_core_a", isActive: true, aliases: [], externalIds: {} });
    expect(v.get("tier2")?.aliases).toContain("t2");
    expect(v.get("t2")?.mergedIntoId).toBe(v.get("tier2")?.id);
  });

  it("move under: the subtree moves with the value, is audited, and cannot go under itself", async () => {
    const before = await values("market_tier");
    const core = before.get("tier1_core");
    const requestId = rid();
    const moved = await call(admin, "PATCH", `/values/${core?.id ?? ""}`, { parentCode: "tier2" }, requestId);
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body).toMatchObject({ parentValueId: before.get("tier2")?.id });
    const after = await values("market_tier");
    expect(after.get("tier1_core")?.path).toBe("tier2.tier1_core");
    expect(after.get("tier1_core_a")?.path).toBe("tier2.tier1_core.tier1_core_a"); // the child moved too
    const audit = await owner.$queryRawUnsafe<Array<{ action: string; before: unknown }>>(`SELECT action, before FROM audit_event WHERE request_id = $1`, requestId);
    expect(audit).toEqual([{ action: "registry.value.updated", before: { parentValueId: before.get("tier1")?.id } }]);
    const events = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE workspace_id = $1::uuid AND topic = 'registry.changed' AND payload->>'kind' = 'value.updated'`, ws);
    expect(Number(events[0]?.n)).toBeGreaterThanOrEqual(1);

    expect((await call(admin, "PATCH", `/values/${core?.id ?? ""}`, { parentCode: "tier1_core_a" })).status).toBe(422); // its own child
    expect((await call(admin, "PATCH", `/values/${core?.id ?? ""}`, { parentCode: "nope" })).status).toBe(422);
    expect((await call(viewer, "PATCH", `/values/${core?.id ?? ""}`, { parentCode: null })).status).toBe(403);
    expect((await call(admin, "PATCH", `/values/${core?.id ?? ""}`, { parentCode: null })).body).toMatchObject({ parentValueId: null });
    expect((await values("market_tier")).get("tier1_core_a")?.path).toBe("tier1_core.tier1_core_a");
  });

  it("hierarchy templates: rename, reorder within allowedParents, and make default", async () => {
    const child = await call(admin, "POST", `/workspaces/${ws}/dimensions`, { key: "store_cluster", label: "Store cluster", dataType: "ENUM", icon: "lucide:store", allowedParents: ["market_tier"], workspaceId: ws });
    expect(child.status, JSON.stringify(child.body)).toBe(201);
    const a = await call(admin, "POST", `/workspaces/${ws}/hierarchy-templates`, { name: "By tier", path: ["market_tier", "store_cluster"], isDefault: true });
    const b = await call(admin, "POST", `/workspaces/${ws}/hierarchy-templates`, { name: "Tier only", path: ["market_tier"] });
    expect([a.status, b.status]).toEqual([201, 201]);
    const id = String(b.body["id"]);
    expect((await call(admin, "PATCH", `/hierarchy-templates/${id}`, { path: ["market_tier", "store_cluster", "store_cluster"] })).status).toBe(422); // store_cluster nests only under market_tier
    expect((await call(admin, "PATCH", `/hierarchy-templates/${id}`, { name: "By tier" })).status).toBe(409);
    expect((await call(viewer, "PATCH", `/hierarchy-templates/${id}`, { name: "x" })).status).toBe(403);
    const requestId = rid();
    const u = await call(admin, "PATCH", `/hierarchy-templates/${id}`, { name: "Tier and cluster", path: ["market_tier", "store_cluster"], isDefault: true }, requestId);
    expect(u.body).toEqual({ id, name: "Tier and cluster", path: ["market_tier", "store_cluster"], isDefault: true });
    const audit = await owner.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_event WHERE request_id = $1`, requestId);
    expect(audit.map((x) => x.action)).toEqual(["registry.template.updated"]);
    const list = (await call(viewer, "GET", `/workspaces/${ws}/hierarchy-templates`)).body as unknown as Array<{ id: string; isDefault: boolean }>;
    expect(list.filter((x) => x.isDefault).map((x) => x.id)).toEqual([id]); // one default
  });

  it("an uploaded SVG icon is served back sanitized, to any member", async () => {
    const up = await call(admin, "POST", "/assets", { contentType: "image/svg+xml", svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><script>alert(1)</script><circle cx="12" cy="12" r="10"/></svg>` });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const file = String(up.body["gcsObject"]).replace("icons/", "");
    const got = await call(viewer, "GET", `/assets/icons/${file}`);
    expect(got.body["icon"]).toBe(up.body["icon"]);
    expect(String(got.body["svg"])).toContain("<circle");
    expect(String(got.body["svg"])).not.toContain("script");
    expect((await call(viewer, "GET", `/assets/icons/${randomUUID()}.svg`)).status).toBe(404);
    expect((await call(viewer, "GET", `/assets/icons/..%2Fsecret`)).status).toBe(404);
  });
});
