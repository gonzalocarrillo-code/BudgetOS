import { randomUUID } from "node:crypto";
import { asOrgAdmin, ensurePartitions, type Tx } from "@budget/db";
import { deleteWorkspaceForTests } from "@budget/workers";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ownerDb, startHarness, testUser, type Harness } from "../../test-support/harness.js";

/**
 * EX-7 (ADR-0093) expand safety: a convention saved by EX-6 (aliases in its tokens, no `kind`) and
 * never re-saved still matches after deploy, before any dictionary row exists for its granularities.
 */
const owner = ownerDb();
let h: Harness;
const orgId = randomUUID();
const ws = randomUUID();
const admin = testUser("ex7-legacy", randomUUID());
const asAdmin = <T,>(fn: (tx: Tx) => Promise<T>) => asOrgAdmin(owner, fn, orgId);
const fact = randomUUID();
const envelope = randomUUID();

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "ex7-legacy" } });
  await asAdmin((tx) => tx.workspace.create({ data: { id: ws, orgId, slug: `ex7l-${ws}`, name: "EX-7 legacy", reportingCurrency: "USD" } }));
  await owner.user.create({ data: { id: admin.id, orgId, email: admin.email, name: admin.email, googleSub: `g-${admin.sub}` } });
  await owner.roleAssignment.create({ data: { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: admin.id, role: "DATA_ADMIN", createdBy: admin.id } });
  await ensurePartitions(owner, "2026-01-01", "2026-12-31");
  await asAdmin(async (tx) => {
    for (const [key, values] of [["country", [["BR", "Brazil"]]], ["platform", [["meta", "Meta"]]], ["campaign", [["c-1", "BR_Zz_VideoA"]]]] as const) {
      const dim = randomUUID();
      await tx.$executeRawUnsafe(`INSERT INTO dimension (id, org_id, workspace_id, key, label, data_type, created_by) VALUES ($1::uuid, $2::uuid, NULL, $3, $3, 'ENUM', $4::uuid)`, dim, orgId, key, admin.id);
      for (const [code, label] of values) await tx.$executeRawUnsafe(`INSERT INTO dimension_value (id, dimension_id, code, label) VALUES ($1::uuid, $2::uuid, $3, $4)`, randomUUID(), dim, code, label);
    }
    // Written by EX-6: no `kind`, an alias Zz → meta that no dictionary or registry value reads.
    await tx.$executeRawUnsafe(`INSERT INTO naming_convention (id, workspace_id, delimiter, tokens, created_by) VALUES ($1::uuid, $2::uuid, '_', $3::jsonb, $4::uuid)`, randomUUID(), ws, JSON.stringify([{ dimension: "country", aliases: {} }, { dimension: "platform", aliases: { Zz: "meta" } }, { dimension: null, aliases: {} }]), admin.id);
    await tx.$executeRawUnsafe(
      `INSERT INTO envelope (id, workspace_id, name, dimension_values, start_date, end_date, currency, status, created_by, updated_at) VALUES ($1::uuid, $2::uuid, 'BR Meta', $3::jsonb, '2026-01-01', '2026-12-31', 'USD', 'APPROVED', $4::uuid, now())`,
      envelope,
      ws,
      JSON.stringify({ country: "BR", platform: "meta" }),
      admin.id,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO spend_fact (id, workspace_id, dimension_values, period_date, currency, amount, amount_reporting, source_system, source_run_id, source_row_hash, natural_key)
       VALUES ($1::uuid, $2::uuid, '{"campaign":"c-1"}'::jsonb, '2026-03-01', 'USD', 10, 10, 'test', $3::uuid, $4, $4)`,
      fact,
      ws,
      randomUUID(),
      `ex7l-${fact}`,
    );
  });
  h = await startHarness();
}, 60_000);

afterAll(async () => {
  await h?.close();
  await deleteWorkspaceForTests(owner, ws, orgId);
  await asAdmin(async (tx) => {
    await tx.$executeRawUnsafe(`DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`, orgId);
    await tx.$executeRawUnsafe(`DELETE FROM dimension WHERE org_id = $1::uuid`, orgId);
  });
  await owner.roleAssignment.deleteMany({ where: { principalId: admin.id } });
  await owner.user.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await owner.$disconnect();
});

it("an EX-6 alias convention, never re-saved, still matches with no dictionary rows", async () => {
  const res = await h.call("POST", `/api/v1/workspaces/${ws}/match-rules/rematch`, await h.mint(admin), { headers: { "x-workspace-id": ws }, body: {} });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const rows = await asAdmin((tx) => tx.$queryRawUnsafe<Array<{ envelope_id: string | null; n: bigint }>>(`SELECT (SELECT envelope_id::text FROM spend_fact WHERE id = $1::uuid) AS envelope_id, (SELECT count(*) FROM naming_dictionary_entry WHERE workspace_id = $2::uuid) AS n`, fact, ws));
  expect(Number(rows[0]?.n)).toBe(0);
  expect(rows[0]?.envelope_id).toBe(envelope);
});
