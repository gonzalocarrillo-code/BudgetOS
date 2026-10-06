import { deleteWorkspaceForTests } from "@budget/workers";
import type { PrismaClient } from "@prisma/client";
import { asOrgAdmin } from "@budget/db";
import type { GoldenResult } from "../seed/golden.js";

/**
 * Deletes a golden workspace a test seeded, and its org, as the owner role. One list for every
 * golden-based test: a new golden entity type (T-015 targets and metrics, …) is added once, here.
 * Statements for tables a test never wrote are no-ops.
 *
 * W0-6: the owner has no BYPASSRLS, so every DELETE below needs the org-admin tenant context real
 * writes get from `withTenant` — without it, FORCE RLS silently deletes zero rows (DELETE, unlike
 * INSERT, has no WITH CHECK to raise on), leaving orphans that then fail a later statement's own
 * foreign key (what first surfaced this: `DELETE FROM organization` failing because `workspace`
 * rows never actually left).
 */
export async function cleanupGolden(owner: PrismaClient, golden: GoldenResult): Promise<void> {
  // Every workspace of the org: a test may have created more (T-040: a workspace from a template).
  // The e2e teardown passes only the workspace id, so the org comes from the workspace; never an
  // unfiltered query. W0-6: this one lookup has no org to give asOrgAdmin (that is what it is
  // trying to discover) — every current caller always has golden.orgId already, so this stays
  // unreachable in practice; a caller that genuinely only has the workspace id would need its own
  // org lookup (e.g. golden.ts's organization-name trick) before this function could help it.
  const orgId = golden.orgId ?? (await asOrgAdmin(owner, (tx) => tx.workspace.findUnique({ where: { id: golden.workspaceId }, select: { orgId: true } })))?.orgId;
  if (orgId) {
    const others = await asOrgAdmin(owner, (tx) => tx.workspace.findMany({ where: { orgId, id: { not: golden.workspaceId } }, select: { id: true } }), orgId);
    for (const w of others) await cleanupWorkspace(owner, w.id, orgId);
  }
  await cleanupWorkspace(owner, golden.workspaceId, orgId);
  if (!orgId) return;
  await asOrgAdmin(
    owner,
    async (tx) => {
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
        await tx.$executeRawUnsafe(sql, orgId);
      }
      await tx.$executeRawUnsafe(`DELETE FROM organization WHERE id = $1::uuid`, orgId);
    },
    orgId,
  );
}

/**
 * The workspace's own rows and the workspace itself (T-040: a test's extra workspace in the
 * golden org). W3-11 (audit I-32): delegates to `@budget/workers`'s `deleteWorkspaceForTests`,
 * which reuses the exact FK-safe table order `purgeWorkspace` validates against production (every
 * tenant table's workspace_id, and the circular/self-referencing pointer columns, are now FKs).
 * W0-6: the owner has no BYPASSRLS, so `orgId` must be given — `deleteWorkspaceForTests` needs the
 * org-admin tenant context real writes get from `withTenant`. The one caller above with no org to
 * give (see its comment) skips the delete rather than fail; every other caller always has one.
 */
export async function cleanupWorkspace(owner: PrismaClient, ws: string, orgId?: string | null): Promise<void> {
  if (!orgId) return;
  await deleteWorkspaceForTests(owner, ws, orgId);
}
