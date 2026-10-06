import { deleteWorkspaceForTests } from "@budget/workers";
import type { PrismaClient } from "@prisma/client";
import type { GoldenResult } from "../seed/golden.js";

/**
 * Deletes a golden workspace a test seeded, and its org, as the owner role. One list for every
 * golden-based test: a new golden entity type (T-015 targets and metrics, …) is added once, here.
 * Statements for tables a test never wrote are no-ops.
 */
export async function cleanupGolden(owner: PrismaClient, golden: GoldenResult): Promise<void> {
  // Every workspace of the org: a test may have created more (T-040: a workspace from a template).
  // The e2e teardown passes only the workspace id, so the org comes from the workspace; never an unfiltered query.
  const orgId = golden.orgId ?? (await owner.workspace.findUnique({ where: { id: golden.workspaceId }, select: { orgId: true } }))?.orgId;
  if (orgId) {
    const others = await owner.workspace.findMany({ where: { orgId, id: { not: golden.workspaceId } }, select: { id: true } });
    for (const w of others) await cleanupWorkspace(owner, w.id);
  }
  await cleanupWorkspace(owner, golden.workspaceId);
  if (!orgId) return;
  for (const sql of [
    `DELETE FROM metric_definition WHERE org_id = $1::uuid`,
    // W3-11 (audit I-32): dimension_value.parent_value_id / merged_into_id are self-referencing
    // FKs now; a hierarchy (e.g. region > country) needs both nulled before the bulk delete.
    `UPDATE dimension_value SET parent_value_id = NULL, merged_into_id = NULL WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`,
    `DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`,
    `DELETE FROM dimension WHERE org_id = $1::uuid`,
    `DELETE FROM role_assignment WHERE principal_id IN (SELECT id FROM app_user WHERE org_id = $1::uuid)`,
    `DELETE FROM app_user WHERE org_id = $1::uuid`,
  ]) {
    await owner.$executeRawUnsafe(sql, orgId);
  }
  await owner.$executeRawUnsafe(`DELETE FROM organization WHERE id = $1::uuid`, orgId);
}

/**
 * The workspace's own rows and the workspace itself (T-040: a test's extra workspace in the
 * golden org). W3-11 (audit I-32): delegates to `@budget/workers`'s `deleteWorkspaceForTests`,
 * which reuses the exact FK-safe table order `purgeWorkspace` validates against production (every
 * tenant table's workspace_id, and the circular/self-referencing pointer columns, are now FKs).
 */
export async function cleanupWorkspace(owner: PrismaClient, ws: string): Promise<void> {
  await deleteWorkspaceForTests(owner, ws);
}
