import "../test-support/env.js";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { asOrgAdmin } from "@budget/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteWorkspaceForTests } from "../purge/purge.js";
import { checkSnapshotIntegrity } from "./snapshots.js";

/**
 * D-015 (docs/DATA_PLAN.md §8.2): a snapshot whose header disagrees with its rows is found, and the
 * org's superadmins are told in-app, with one audit and one outbox row; a clean org finds nothing.
 */
const url = (k: string) => process.env[k] ?? "";
const owner = new PrismaClient({ datasources: { db: { url: url("DATABASE_URL") } } });
const app = new PrismaClient({ datasources: { db: { url: url("APP_DATABASE_URL") } } });
const orgId = randomUUID();
const ws = randomUUID();
const superadmin = randomUUID();
const env = randomUUID();
const snap = randomUUID();

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "integrity" } });
  await owner.user.create({ data: { id: superadmin, orgId, email: `${superadmin}@integrity.test`, name: "Super", googleSub: superadmin } });
  await owner.roleAssignment.create({ data: { id: randomUUID(), workspaceId: null, principalType: "user", principalId: superadmin, role: "ORG_ADMIN", createdBy: superadmin } });
  // W0-6: the owner has no BYPASSRLS; workspace and the workspace-scoped rows below need the same
  // org-admin tenant context real writes get from withTenant.
  await asOrgAdmin(
    owner,
    async (tx) => {
      await tx.workspace.create({ data: { id: ws, orgId, slug: `integrity-${ws}`, name: "Integrity", reportingCurrency: "USD" } });
      await tx.$executeRawUnsafe(`INSERT INTO envelope (id, workspace_id, name, dimension_values, start_date, end_date, currency, status, created_by, updated_at) VALUES ($1::uuid, $2::uuid, 'e', '{}', '2026-01-01', '2026-12-31', 'USD', 'APPROVED', $3::uuid, now())`, env, ws, superadmin);
      await tx.$executeRawUnsafe(`INSERT INTO budget_baseline (id, workspace_id, name, kind, scope, as_of, taken_by, row_count, total_reporting) VALUES ($1::uuid, $2::uuid, 'Plan', 'plan', '{}', now(), $3::uuid, 1, 100)`, snap, ws, superadmin);
      await tx.$executeRawUnsafe(
        `INSERT INTO budget_baseline_row (baseline_id, workspace_id, envelope_id, version_id, amount, amount_reporting, currency, parent_id, name, dimension_values, start_date, end_date, is_leaf) VALUES ($1::uuid, $2::uuid, $3::uuid, NULL, 100, 100, 'USD', NULL, 'e', '{}', '2026-01-01', '2026-12-31', true)`,
        snap, ws, env,
      );
    },
    orgId,
  );
});

afterAll(async () => {
  // W3-11 (audit I-32): deletes every row that FKs to this workspace (and the workspace row
  // itself), in the same order `purgeWorkspace` validates against production.
  // W0-6: the owner has no BYPASSRLS; pass orgId so deleteWorkspaceForTests runs under org-admin
  // tenant context.
  await deleteWorkspaceForTests(owner, ws, orgId);
  await owner.roleAssignment.deleteMany({ where: { principalId: superadmin } });
  await owner.user.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describe("snapshot integrity (D-015)", () => {
  it("a clean org finds nothing", async () => {
    expect(await checkSnapshotIntegrity(app, [orgId])).toEqual([]);
  });

  it("a header that disagrees with its rows is found, and superadmins are told", async () => {
    await asOrgAdmin(owner, (tx) => tx.$executeRawUnsafe(`UPDATE budget_baseline SET row_count = 2, total_reporting = 150 WHERE id = $1::uuid`, snap), orgId);
    const findings = await checkSnapshotIntegrity(app, [orgId]);
    expect(findings).toEqual([{ workspaceId: ws, foreignRows: 0, foreignEnvelopes: 0, headerMismatches: [{ id: snap, name: "Plan", rowCount: 2, rows: 1, total: "150.00", rowsTotal: "100.00" }] }]);
    const { notes, audits, out } = await asOrgAdmin(
      owner,
      async (tx) => ({
        notes: await tx.$queryRawUnsafe<Array<{ user_id: string; kind: string }>>(`SELECT user_id::text, kind FROM notification WHERE workspace_id = $1::uuid`, ws),
        audits: await tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM audit_event WHERE workspace_id = $1::uuid AND action = 'integrity.snapshots'`, ws),
        out: await tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM outbox WHERE workspace_id = $1::uuid AND topic = 'integrity.alert'`, ws),
      }),
      orgId,
    );
    expect(notes).toEqual([{ user_id: superadmin, kind: "integrity.snapshots" }]);
    expect([Number(audits[0]?.n), Number(out[0]?.n)]).toEqual([1, 1]);
  });
});
