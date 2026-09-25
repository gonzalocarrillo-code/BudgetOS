import "../test-support/env.js";
import { randomUUID } from "node:crypto";
import { outbox, withTenant } from "@budget/db";
import { compileTree } from "@budget/query-planner";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleRollupEvent, rebuildWorkspace } from "./rollup.js";

/**
 * T-022 rollup-worker on a small workspace: a missing dimension is a `∅` segment, a node knows the
 * envelope whose tuple it is, parents never count twice, and archiving a leaf removes a node that
 * becomes empty. The golden tree == pivot check is in apps/api/src/seed/golden.test.ts.
 */

const url = (key: string) => {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set (packages/db/.env)`);
  return v;
};
const owner = new PrismaClient({ datasources: { db: { url: url("DATABASE_URL") } } });
const app = new PrismaClient({ datasources: { db: { url: url("APP_DATABASE_URL") } } });
const orgId = randomUUID();
const ws = randomUUID();
const userId = randomUUID();
const templateId = randomUUID();
const period = { start: "2026-01-01", end: "2026-12-31" };
const TODAY = "2026-06-30";
const env: Record<string, string> = {};

async function envelope(name: string, dims: Record<string, string>, budget: string, parentId: string | null = null): Promise<string> {
  const id = randomUUID();
  const v = randomUUID();
  await owner.$executeRawUnsafe(
    `INSERT INTO envelope (id, workspace_id, parent_id, name, dimension_values, start_date, end_date, currency, status, created_by, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, '2026-01-01', '2026-12-31', 'USD', 'APPROVED', $6::uuid, now())`,
    id, ws, parentId, name, JSON.stringify(dims), userId,
  );
  await owner.$executeRawUnsafe(`INSERT INTO envelope_version (id, envelope_id, version_no, amount, amount_reporting, status, created_by, approved_at) VALUES ($1::uuid, $2::uuid, 1, $3::numeric, $3::numeric, 'APPROVED', $4::uuid, '2026-01-02T00:00:00Z')`, v, id, budget, userId);
  await owner.$executeRawUnsafe(`UPDATE envelope SET current_version_id = $2::uuid WHERE id = $1::uuid`, id, v);
  for (const [key, code] of Object.entries(dims)) {
    await owner.$executeRawUnsafe(
      `INSERT INTO envelope_dimension (envelope_id, dimension_id, value_id) SELECT $1::uuid, d.id, dv.id FROM dimension d JOIN dimension_value dv ON dv.dimension_id = d.id WHERE d.org_id = $2::uuid AND d.key = $3 AND dv.code = $4`,
      id, orgId, key, code,
    );
  }
  return id;
}
async function tree(): Promise<Record<string, string>> {
  const c = compileTree({ workspaceId: ws, templateId, period });
  const rows = await withTenant(app, { workspaceId: ws, orgId, userId: null, isOrgAdmin: false, actorType: "system", requestId: `t022-${randomUUID()}` }, (tx) => tx.$queryRawUnsafe<Array<{ node_path: string; measures: { budget: string | null } }>>(c.sql, ...c.values));
  return Object.fromEntries(rows.map((r) => [r.node_path, String(r.measures.budget)]));
}
const envelopeOfNode = async (path: string) => (await owner.$queryRawUnsafe<Array<{ envelope_id: string | null }>>(`SELECT envelope_id::text FROM rollup_cache WHERE template_id = $1::uuid AND node_path = $2`, templateId, path))[0]?.envelope_id ?? null;

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "t022" } });
  await owner.workspace.create({ data: { id: ws, orgId, slug: `t022-${ws}`, name: "T-022", reportingCurrency: "USD", fiscalYearStartMonth: 1 } });
  await owner.user.create({ data: { id: userId, orgId, email: `${userId}@t022.test`, name: "T-022", googleSub: `g-${userId}` } });
  for (const [key, codes] of [["region", ["LATAM", "EMEA"]], ["platform", ["meta", "tiktok"]]] as const) {
    const id = randomUUID();
    await owner.$executeRawUnsafe(`INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by) VALUES ($1::uuid, $2::uuid, NULL, $3, $3, 'ENUM', $4::uuid)`, id, orgId, key, userId);
    for (const code of codes) await owner.$executeRawUnsafe(`INSERT INTO dimension_value (id, dimension_id, code, label) VALUES ($1::uuid, $2::uuid, $3, $3)`, randomUUID(), id, code);
  }
  await owner.hierarchyTemplate.create({ data: { id: templateId, workspaceId: ws, name: "Region > platform", path: ["region", "platform"], createdBy: userId } });
  env["latam"] = await envelope("LATAM", { region: "LATAM" }, "1000.00"); // a parent: a cap, never summed
  env["latamMeta"] = await envelope("LATAM meta", { region: "LATAM", platform: "meta" }, "300.00", env["latam"]);
  env["latamTiktok"] = await envelope("LATAM tiktok", { region: "LATAM", platform: "tiktok" }, "200.00", env["latam"]);
  env["emea"] = await envelope("EMEA (no platform)", { region: "EMEA" }, "50.00");
});

afterAll(async () => {
  const envs = `(SELECT id FROM envelope WHERE workspace_id = $1::uuid)`;
  for (const sql of [
    `DELETE FROM rollup_cache WHERE workspace_id = $1::uuid`,
    `DELETE FROM processed_event WHERE outbox_id IN (SELECT id FROM outbox WHERE workspace_id = $1::uuid)`,
    `DELETE FROM outbox WHERE workspace_id = $1::uuid`,
    `DELETE FROM hierarchy_template WHERE workspace_id = $1::uuid`,
    `DELETE FROM envelope_dimension WHERE envelope_id IN ${envs}`,
    `UPDATE envelope SET current_version_id = NULL, parent_id = NULL WHERE workspace_id = $1::uuid`,
    `DELETE FROM envelope_version WHERE envelope_id IN ${envs}`,
    `DELETE FROM envelope WHERE workspace_id = $1::uuid`,
  ]) {
    await owner.$executeRawUnsafe(sql, ws);
  }
  await owner.$executeRawUnsafe(`DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`, orgId);
  await owner.$executeRawUnsafe(`DELETE FROM dimension WHERE org_id = $1::uuid`, orgId);
  await owner.user.deleteMany({ where: { orgId } });
  await owner.workspace.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("rollup-worker", () => {
  it("builds the tree over live leaves: parents never add, a missing dimension is ∅", async () => {
    await rebuildWorkspace(app, { workspaceId: ws, orgId }, { today: TODAY, periods: [period] });
    expect(await tree()).toEqual({ "": "550.00", EMEA: "50.00", "EMEA/∅": "50.00", LATAM: "500.00", "LATAM/meta": "300.00", "LATAM/tiktok": "200.00" });
    expect(await envelopeOfNode("LATAM")).toBe(env["latam"]);
    expect(await envelopeOfNode("LATAM/meta")).toBe(env["latamMeta"]);
    expect(await envelopeOfNode("EMEA/∅")).toBeNull();
  });

  it("archiving a leaf refreshes its path and removes the node it leaves empty, once per event", async () => {
    await owner.$executeRawUnsafe(`UPDATE envelope SET status = 'ARCHIVED' WHERE id = $1::uuid`, env["latamTiktok"]);
    await withTenant(app, { workspaceId: ws, orgId, userId: null, isOrgAdmin: false, actorType: "system", requestId: `t022-${randomUUID()}` }, (tx) => outbox(tx, { workspaceId: ws, topic: "budget.changed", payload: { envelopeId: env["latamTiktok"], kind: "archived" } }));
    const [row] = await owner.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id::text FROM outbox WHERE workspace_id = $1::uuid ORDER BY id DESC LIMIT 1`, ws);
    const body = { message: { data: Buffer.from(JSON.stringify({ envelopeId: env["latamTiktok"], kind: "archived" })).toString("base64"), attributes: { outboxId: row?.id ?? "", workspaceId: ws, orgId, topic: "budget.changed" }, messageId: "m" }, subscription: "rollup-worker" };
    const first = await handleRollupEvent(app, body, TODAY);
    expect(first).toMatchObject({ outcome: "applied", deleted: 1 });
    expect(await tree()).toEqual({ "": "350.00", EMEA: "50.00", "EMEA/∅": "50.00", LATAM: "300.00", "LATAM/meta": "300.00" });
    expect((await handleRollupEvent(app, body, TODAY)).outcome).toBe("duplicate");
  });
});
