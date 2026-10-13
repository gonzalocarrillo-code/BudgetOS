import { randomUUID } from "node:crypto";
import { asOrgAdmin, ensurePartitions, type Tx } from "@budget/db";
import { deleteWorkspaceForTests } from "@budget/workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerDb, startHarness, testUser, type Harness, type TestUser } from "../../test-support/harness.js";

/**
 * EX-9 (ADR-0094): campaign is a data-derived granularity. The registry lists it with
 * `valuesSource: "facts"` and no hand-managed values; its values come from one endpoint over the
 * facts (search + pages); adding, editing, merging or retiring one of its values is refused with
 * 422 VALIDATION (never a silent success); ⌘K's `campaign:` suggestions read the same facts.
 */

const owner = ownerDb();
let h: Harness;
const orgId = randomUUID();
const ws = randomUUID();
const orgAdmin = testUser("ex9-orgadmin", randomUUID());
const viewer = testUser("ex9-viewer", randomUUID());
const X = { "x-workspace-id": ws };
let seq = 0;
const rid = () => `ex9-${++seq}-${orgId}`;
let campaignDim = "";
let legacyValue = "";

type Res = { status: number; body: Record<string, unknown> };
async function call(user: TestUser, method: "GET" | "POST" | "PATCH", url: string, body?: unknown): Promise<Res> {
  return h.call(method, `/api/v1${url}`, await h.mint(user), { headers: { ...X, "x-request-id": rid() }, ...(body === undefined ? {} : { body }) });
}
const asOwner = <T>(fn: (tx: Tx) => Promise<T>) => asOrgAdmin(owner, fn, orgId);

async function spend(campaign: string, date: string, amount: string): Promise<void> {
  await asOwner((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO spend_fact (workspace_id, dimension_values, period_date, currency, amount, amount_reporting, source_system, source_run_id, source_row_hash, natural_key)
       VALUES ($1::uuid, $2::jsonb, $3::date, 'USD', $4::numeric, $4::numeric, 'bigquery', $5::uuid, $6, $6)`,
      ws,
      JSON.stringify({ platform: "meta", campaign }),
      date,
      amount,
      randomUUID(),
      `ex9-api-${++seq}`,
    ),
  );
}

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "ex9" } });
  await asOrgAdmin(owner, (tx) => tx.workspace.create({ data: { id: ws, orgId, slug: `ex9-${ws}`, name: "EX-9", reportingCurrency: "USD" } }), orgId);
  await owner.user.createMany({ data: [orgAdmin, viewer].map((u) => ({ id: u.id, orgId, email: u.email, name: `Name ${u.sub}`, googleSub: `g-${u.sub}` })) });
  await owner.roleAssignment.createMany({
    data: [
      { id: randomUUID(), workspaceId: null, principalType: "user", principalId: orgAdmin.id, role: "ORG_ADMIN", scope: {}, createdBy: orgAdmin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: viewer.id, role: "VIEWER", scope: {}, createdBy: orgAdmin.id },
    ],
  });
  await ensurePartitions(owner, "2026-01-01", "2026-12-31");
  await spend("Spring_Sale", "2026-02-03", "100.10");
  await spend("Spring_Sale", "2026-02-10", "0.20");
  await spend("Summer_Launch", "2026-05-01", "250.00");
  h = await startHarness();
  // The org-wide campaign dimension as the default registry seeds it: data-derived.
  const created = await call(orgAdmin, "POST", `/workspaces/${ws}/dimensions`, { key: "campaign", label: "Campaign", dataType: "TEXT", icon: "lucide:megaphone", workspaceId: null, valuesSource: "facts" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  campaignDim = String(created.body["id"]);
  // A pre-EX-9 campaign registry row (EX-3's demo seed wrote these): kept, but no longer editable.
  legacyValue = randomUUID();
  await asOwner((tx) => tx.$executeRawUnsafe(`INSERT INTO dimension_value (id, dimension_id, code, label) VALUES ($1::uuid, $2::uuid, 'Legacy_Campaign', 'Legacy campaign')`, legacyValue, campaignDim));
}, 60_000);

afterAll(async () => {
  await h?.close();
  await deleteWorkspaceForTests(owner, ws, orgId);
  await asOrgAdmin(
    owner,
    async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE dimension_value SET parent_value_id = NULL, merged_into_id = NULL WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`, orgId);
      await tx.$executeRawUnsafe(`DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`, orgId);
      await tx.$executeRawUnsafe(`DELETE FROM dimension WHERE org_id = $1::uuid`, orgId);
    },
    orgId,
  );
  await owner.roleAssignment.deleteMany({ where: { principalId: { in: [orgAdmin.id, viewer.id] } } });
  await owner.user.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await owner.$disconnect();
});

describe("campaign is a data-derived granularity (EX-9)", () => {
  it("the registry lists it as `facts` with no hand-managed values", async () => {
    const dims = (await call(viewer, "GET", `/workspaces/${ws}/dimensions`)).body as unknown as Array<{ key: string; valuesSource: string; values: unknown[] }>;
    const campaign = dims.find((d) => d.key === "campaign");
    expect(campaign).toMatchObject({ valuesSource: "facts", values: [] });
  });

  it("its values are the facts' distinct campaigns with their spend, searchable and paged", async () => {
    const all = await call(viewer, "GET", `/workspaces/${ws}/dimensions/campaign/fact-values`);
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(all.body).toMatchObject({ key: "campaign", valuesSource: "facts", total: 2, limit: 50, offset: 0 });
    expect(all.body["items"]).toEqual([
      { code: "Summer_Launch", spend: "250.00", currency: "USD", firstSeen: "2026-05-01", lastSeen: "2026-05-01", sourceSystems: ["bigquery"] },
      { code: "Spring_Sale", spend: "100.30", currency: "USD", firstSeen: "2026-02-03", lastSeen: "2026-02-10", sourceSystems: ["bigquery"] },
    ]);
    const searched = await call(viewer, "GET", `/workspaces/${ws}/dimensions/campaign/fact-values?q=spring&limit=1`);
    expect(searched.body).toMatchObject({ total: 1, limit: 1, items: [{ code: "Spring_Sale" }] });
    expect((await call(viewer, "GET", `/workspaces/${ws}/dimensions/campaign/fact-values?limit=0`)).status).toBe(422);
    // A registry dimension's values are not data-derived.
    expect((await call(viewer, "GET", `/workspaces/${ws}/dimensions/nope/fact-values`)).status).toBe(404);
  });

  it("refuses to add, edit, merge or retire a value of a data-derived dimension (422 VALIDATION)", async () => {
    const add = await call(orgAdmin, "POST", `/dimensions/${campaignDim}/values`, { values: [{ code: "Typed_By_Hand", label: "Typed by hand" }] });
    expect(add.status, JSON.stringify(add.body)).toBe(422);
    expect(add.body).toMatchObject({ code: "VALIDATION" });
    const edit = await call(orgAdmin, "PATCH", `/values/${legacyValue}`, { label: "Renamed" });
    expect(edit.status, JSON.stringify(edit.body)).toBe(422);
    const retire = await call(orgAdmin, "PATCH", `/values/${legacyValue}`, { isActive: false });
    expect(retire.status).toBe(422);
    const merge = await call(orgAdmin, "POST", `/values/${legacyValue}/merge`, { fromCode: "Legacy_Campaign", intoCode: "Spring_Sale" });
    expect(merge.status, JSON.stringify(merge.body)).toBe(422);
    // Nothing was written: the legacy row is untouched and no new row exists.
    const rows = await asOwner((tx) => tx.$queryRawUnsafe<Array<{ code: string; label: string; is_active: boolean }>>(`SELECT code, label, is_active FROM dimension_value WHERE dimension_id = $1::uuid`, campaignDim));
    expect(rows).toEqual([{ code: "Legacy_Campaign", label: "Legacy campaign", is_active: true }]);
  });

  it("⌘K `campaign:` suggestions come from the facts", async () => {
    const res = await call(viewer, "GET", `/workspaces/${ws}/search/suggest?prefix=campaign:sum`);
    expect(res.status).toBe(200);
    expect(res.body["values"]).toEqual([{ value: "Summer_Launch", label: "Summer_Launch" }]);
  });
});
