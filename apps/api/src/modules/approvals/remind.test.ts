import { randomUUID } from "node:crypto";
import type { Role } from "@budget/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthContext } from "../../common/tenant.js";
import { appDb, ownerDb } from "../../test-support/harness.js";
import { remindApprovers } from "./commands/remind.js";

/** S-004: the requester (or an admin) reminds a request's approvers, at most once an hour; audited, with its outbox row. */

const owner = ownerDb();
const app = appDb();
const orgId = randomUUID();
const ws = randomUUID();
const u = { planner: randomUUID(), approver: randomUUID(), admin: randomUUID() };
const envelopeId = randomUUID();

const auth = (who: keyof typeof u, role: Role): AuthContext => ({
  ctx: { workspaceId: ws, orgId, userId: u[who], isOrgAdmin: false, actorType: "user", requestId: `s004-${randomUUID()}` },
  user: { id: u[who], orgId, email: `${who}@s004.test`, name: `Name ${who}` },
  isOrgAdmin: false,
  roles: [role],
  assignments: [{ role, scope: {} }],
});

async function request(status = "PENDING"): Promise<string> {
  const id = randomUUID();
  const versionId = randomUUID();
  await owner.envelopeVersion.create({ data: { id: versionId, envelopeId, versionNo: 1 + Math.floor(Math.random() * 1e6), amount: "1150.00", amountReporting: "1150.00", status: "PENDING", createdBy: u.planner } });
  await owner.approvalRequest.create({
    data: { id, workspaceId: ws, entityType: "envelope_version", entityId: versionId, policyId: randomUUID(), policyVersion: 1, policySnapshot: { policyName: "Standard", chain: [{ role: "APPROVER" }], blockSelfApproval: true, allowExternalEvidence: false, conditions: {} }, status: status as "PENDING", summary: "BR Meta: 1000.00 → 1150.00", requestedBy: u.planner },
  });
  return id;
}

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "s004" } });
  await owner.workspace.create({ data: { id: ws, orgId, slug: `s004-${ws}`, name: "S-004", reportingCurrency: "USD" } });
  await owner.user.createMany({ data: Object.entries(u).map(([k, id]) => ({ id, orgId, email: `${k}-${id}@s004.test`, name: `Name ${k}`, googleSub: `g-${id}` })) });
  await owner.$executeRawUnsafe(
    `INSERT INTO envelope (id, workspace_id, name, dimension_values, start_date, end_date, currency, status, owner_id, created_by, updated_at) VALUES ($1::uuid, $2::uuid, 'BR Meta', '{}'::jsonb, '2026-01-01', '2026-12-31', 'USD', 'PENDING', $3::uuid, $3::uuid, now())`,
    envelopeId,
    ws,
    u.planner,
  );
});

afterAll(async () => {
  for (const sql of [
    `DELETE FROM outbox WHERE workspace_id = $1::uuid`,
    `DELETE FROM approval_request WHERE workspace_id = $1::uuid`,
    `DELETE FROM envelope_version WHERE envelope_id IN (SELECT id FROM envelope WHERE workspace_id = $1::uuid)`,
    `DELETE FROM envelope WHERE workspace_id = $1::uuid`,
  ]) {
    await owner.$executeRawUnsafe(sql, ws);
  }
  await owner.user.deleteMany({ where: { orgId } });
  await owner.workspace.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("remind a request's approvers (S-004)", () => {
  it("the requester reminds them: one audit row and one approval.reminded outbox row; again only after an hour", async () => {
    const id = await request();
    expect(await remindApprovers(app, auth("planner", "PLANNER"), id)).toEqual({ requestId: id, step: 0, reminded: true });
    const [a] = await owner.$queryRawUnsafe<Array<{ actor_id: string }>>(`SELECT actor_id::text FROM audit_event WHERE entity_id = $1::uuid AND action = 'approval.reminded'`, id);
    expect(a?.actor_id).toBe(u.planner);
    const rows = await owner.$queryRawUnsafe<Array<{ payload: { requestId: string; step: number } }>>(`SELECT payload FROM outbox WHERE workspace_id = $1::uuid AND topic = 'approval.reminded'`, ws);
    expect(rows.map((r) => r.payload)).toEqual([{ requestId: id, step: 0, by: u.planner }]);

    await expect(remindApprovers(app, auth("planner", "PLANNER"), id)).rejects.toMatchObject({ code: "CONFLICT" });
    const later = new Date(Date.now() + 61 * 60_000);
    expect(await remindApprovers(app, auth("planner", "PLANNER"), id, later)).toMatchObject({ reminded: true });
  });

  it("only the requester or a workspace admin, and only while the request is open", async () => {
    const id = await request();
    await expect(remindApprovers(app, auth("approver", "APPROVER"), id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await remindApprovers(app, auth("admin", "WORKSPACE_ADMIN"), id)).toMatchObject({ reminded: true });
    const closed = await request("APPROVED");
    await expect(remindApprovers(app, auth("planner", "PLANNER"), closed)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(remindApprovers(app, auth("planner", "PLANNER"), randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
