import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { asOrgAdmin, DEFAULT_DIMENSIONS, type Tx } from "@budget/db";
import { handleSearchEvent } from "@budget/workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appDb, ownerDb, startHarness, testUser, type Harness } from "../../test-support/harness.js";

/**
 * HO-004 (docs/HOME_OVERVIEW_PLAN.md, B-5): countries read by the names people use. New workspaces get
 * the short name from the defaults; the migration renames existing values that still carry the ISO
 * 3166 formal name, keeps that name as the external id `iso_name`, audits each change and tells the
 * search index. A value someone renamed keeps its name. Search still finds the formal name.
 */
const MIGRATION = new URL("../../../../../packages/db/prisma/migrations/20261008000000_short_country_labels/migration.sql", import.meta.url);
const owner = ownerDb();
const app = appDb();
let h: Harness;
const orgId = randomUUID();
const ws = randomUUID();
const admin = testUser("ho004-admin", randomUUID());
const country = randomUUID();
const ids = { GB: randomUUID(), US: randomUUID(), BR: randomUUID() };
// W0-6: the owner has no BYPASSRLS; every raw/Prisma call against the workspace- or org-scoped
// tables below needs the org-admin tenant context real writes get from withTenant.
const asAdmin = <T,>(fn: (tx: Tx) => Promise<T>) => asOrgAdmin(owner, fn, orgId);

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "ho004" } });
  await owner.user.create({ data: { id: admin.id, orgId, email: admin.email, name: admin.sub, googleSub: `g-${admin.sub}` } });
  // W0-6: workspace and dimension/dimension_value have no owner_bootstrap policy; they need the
  // org-admin tenant context real writes get from withTenant, with the real org id for the exact
  // org_id match workspace and dimension require.
  await asAdmin(async (tx) => {
    await tx.workspace.create({ data: { id: ws, orgId, slug: `ho004-${ws}`, name: "HO-004", reportingCurrency: "USD", fiscalYearStartMonth: 1 } });
    // An org seeded before HO-004: the formal ISO names, one of them renamed by someone since.
    await tx.$executeRawUnsafe(`INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by) VALUES ($1::uuid, $2::uuid, NULL, 'country', 'Country', 'ENUM', $3::uuid)`, country, orgId, admin.id);
    for (const [code, label] of [["GB", "United Kingdom of Great Britain and Northern Ireland"], ["US", "USA"], ["BR", "Brazil"]] as const) {
      await tx.$executeRawUnsafe(`INSERT INTO dimension_value (id, dimension_id, code, label) VALUES ($1::uuid, $2::uuid, $3, $4)`, ids[code], country, code, label);
    }
  });
  await owner.roleAssignment.create({ data: { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: admin.id, role: "WORKSPACE_ADMIN", createdBy: admin.id } });
  h = await startHarness();
}, 60_000);

afterAll(async () => {
  await h?.close();
  await asAdmin(async (tx) => {
    for (const sql of [`DELETE FROM search_document WHERE workspace_id = $1::uuid`, `DELETE FROM search_term WHERE workspace_id = $1::uuid`, `DELETE FROM processed_event WHERE outbox_id IN (SELECT id FROM outbox WHERE workspace_id = $1::uuid)`, `DELETE FROM outbox WHERE workspace_id = $1::uuid`]) await tx.$executeRawUnsafe(sql, ws);
    await tx.$executeRawUnsafe(`DELETE FROM dimension_value WHERE dimension_id = $1::uuid`, country);
    await tx.$executeRawUnsafe(`DELETE FROM dimension WHERE id = $1::uuid`, country);
    await tx.workspace.deleteMany({ where: { orgId } });
  });
  await owner.roleAssignment.deleteMany({ where: { workspaceId: ws } });
  await owner.user.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

const value = async (id: string) => (await asAdmin((tx) => tx.dimensionValue.findUniqueOrThrow({ where: { id }, select: { label: true, externalIds: true } }))) as { label: string; externalIds: Record<string, string> };
const audits = async (id: string) => Number((await asAdmin((tx) => tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM audit_event WHERE entity_type = 'dimension_value' AND entity_id = $1::uuid AND actor_type = 'system'`, id)))[0]?.n ?? 0);

describe("short country names (HO-004)", () => {
  it("the defaults give new workspaces the short name and keep the formal one", () => {
    const gb = DEFAULT_DIMENSIONS.find((d) => d.key === "country")?.values.find((v) => v.code === "GB");
    expect(gb).toMatchObject({ label: "United Kingdom", externalIds: { iso_name: "United Kingdom of Great Britain and Northern Ireland" } });
    expect(DEFAULT_DIMENSIONS.find((d) => d.key === "country")?.values.find((v) => v.code === "BR")).toEqual({ code: "BR", label: "Brazil", parentCode: "LATAM" });
  });

  it("the migration renames what still carries the formal name, audits it, tells search; a second run does nothing", async () => {
    const dataVersion = async () => Number((await asAdmin((tx) => tx.$queryRawUnsafe<Array<{ v: string | null }>>(`SELECT settings->>'dataVersion' AS v FROM workspace WHERE id = $1::uuid`, ws)))[0]?.v ?? 0);
    const before = await dataVersion();
    await asAdmin((tx) => tx.$executeRawUnsafe(readFileSync(MIGRATION, "utf8")));
    expect(await value(ids.GB)).toMatchObject({ label: "United Kingdom", externalIds: { iso_name: "United Kingdom of Great Britain and Northern Ireland" } });
    expect((await value(ids.US)).label).toBe("USA"); // someone's own name stays
    expect((await value(ids.BR)).label).toBe("Brazil");
    expect(await audits(ids.GB)).toBe(1);
    const events = await asAdmin((tx) => tx.$queryRawUnsafe<Array<{ payload: { dimensionId: string } }>>(`SELECT payload FROM outbox WHERE workspace_id = $1::uuid AND topic = 'registry.changed'`, ws));
    expect(events.map((e) => e.payload.dimensionId)).toEqual([country]);
    expect(await dataVersion()).toBe(before + 1);

    await asAdmin((tx) => tx.$executeRawUnsafe(readFileSync(MIGRATION, "utf8")));
    expect(await audits(ids.GB)).toBe(1);
    expect(Number((await asAdmin((tx) => tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE workspace_id = $1::uuid AND topic = 'registry.changed'`, ws)))[0]?.n)).toBe(1);
  });

  it("search still finds the formal name, and shows the short one", async () => {
    const rows = await asAdmin((tx) => tx.$queryRawUnsafe<Array<{ id: string; topic: string; payload: unknown }>>(`SELECT id::text, topic, payload FROM outbox WHERE workspace_id = $1::uuid ORDER BY id`, ws));
    for (const r of rows) await handleSearchEvent(app, { message: { data: Buffer.from(JSON.stringify(r.payload)).toString("base64"), attributes: { outboxId: r.id, workspaceId: ws, orgId, topic: r.topic }, messageId: r.id }, subscription: "search-indexer" });
    const res = await h.call("GET", `/api/v1/workspaces/${ws}/search?q=${encodeURIComponent("Great Britain")}&limit=5`, await h.mint(admin), { headers: { "x-workspace-id": ws } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const values = (res.body["groups"] as Array<{ type: string; hits: Array<{ title: string }> }>).find((g) => g.type === "dimension_value")?.hits.map((x) => x.title);
    expect(values).toEqual(["United Kingdom"]);
  });
});
