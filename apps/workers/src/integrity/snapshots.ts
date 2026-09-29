import { insertNotification, snapshotIntegrity, withTenant, type SnapshotIntegrity } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { log } from "../log.js";

/**
 * The weekly snapshot integrity check (docs/DATA_PLAN.md §8.2, D-015). For every workspace of the
 * given orgs: no snapshot row belongs to another workspace than its snapshot or its budget, and every
 * snapshot's row count and total match its rows. A finding writes one audit event and one outbox row
 * in that workspace, and an in-app notification to each of the org's superadmins. It reads in an
 * org-level session, so a row pointing at another workspace of the org is visible to it.
 */
export interface IntegrityFinding extends SnapshotIntegrity {
  workspaceId: string;
}

const clean = (r: SnapshotIntegrity) => r.foreignRows === 0 && r.foreignEnvelopes === 0 && r.headerMismatches.length === 0;

export async function checkSnapshotIntegrity(app: PrismaClient, orgIds: readonly string[]): Promise<IntegrityFinding[]> {
  const findings: IntegrityFinding[] = [];
  for (const orgId of orgIds) {
    const org = { workspaceId: null, orgId, userId: null, isOrgAdmin: true, actorType: "system" as const, requestId: `integrity-${orgId}` };
    const { workspaces, superadmins } = await withTenant(app, org, async (tx) => ({
      workspaces: await tx.workspace.findMany({ where: { orgId, purgedAt: null }, select: { id: true } }),
      superadmins: (await tx.roleAssignment.findMany({ where: { workspaceId: null, role: "ORG_ADMIN", principalType: "user" }, select: { principalId: true } })).map((r) => r.principalId),
    }));
    for (const w of workspaces) {
      const result = await withTenant(app, { ...org, workspaceId: w.id }, (tx) => snapshotIntegrity(tx, w.id));
      if (clean(result)) continue;
      findings.push({ workspaceId: w.id, ...result });
      log.error({ workspaceId: w.id, orgId, requestId: org.requestId, ...result }, "snapshot integrity check found a problem");
      await withTenant(app, { ...org, workspaceId: w.id }, async (tx) => {
        await tx.$executeRaw`INSERT INTO audit_event (workspace_id, actor_id, actor_type, action, entity_type, entity_id, before, after, request_id)
          VALUES (${w.id}::uuid, NULL, 'system', 'integrity.snapshots', 'workspace', ${w.id}::uuid, 'null'::jsonb, ${JSON.stringify(result)}::jsonb, ${org.requestId})`;
        await tx.$executeRaw`INSERT INTO outbox (workspace_id, topic, payload) VALUES (${w.id}::uuid, 'integrity.alert', ${JSON.stringify({ workspaceId: w.id, check: "snapshots", ...result })}::jsonb)`;
        for (const userId of superadmins) await insertNotification(tx, { workspaceId: w.id, userId, kind: "integrity.snapshots", payload: { headerMismatches: result.headerMismatches.map((m) => m.name), foreignRows: result.foreignRows, foreignEnvelopes: result.foreignEnvelopes } });
      });
    }
  }
  return findings;
}
