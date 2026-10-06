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

/** The workspace's own rows and the workspace (T-040: a test's extra workspace in the golden org). */
export async function cleanupWorkspace(owner: PrismaClient, ws: string): Promise<void> {
  const envs = `(SELECT id FROM envelope WHERE workspace_id = $1::uuid)`;
  for (const sql of [
    `DELETE FROM budget_baseline_row WHERE workspace_id = $1::uuid`,
    `DELETE FROM budget_baseline WHERE workspace_id = $1::uuid`,
    `DELETE FROM notification WHERE workspace_id = $1::uuid`,
    `DELETE FROM search_document WHERE workspace_id = $1::uuid`,
    `DELETE FROM search_term WHERE workspace_id = $1::uuid`,
    `DELETE FROM rollup_cache WHERE workspace_id = $1::uuid`,
    `DELETE FROM export_job WHERE workspace_id = $1::uuid`,
    `DELETE FROM saved_view WHERE workspace_id = $1::uuid`,
    `DELETE FROM closure_envelope WHERE closure_id IN (SELECT id FROM period_closure WHERE workspace_id = $1::uuid)`,
    `DELETE FROM period_closure WHERE workspace_id = $1::uuid`,
    `DELETE FROM fiscal_period WHERE workspace_id = $1::uuid`,
    `DELETE FROM processed_event WHERE outbox_id IN (SELECT id FROM outbox WHERE workspace_id = $1::uuid)`,
    `DELETE FROM subscription WHERE workspace_id = $1::uuid`,
    `DELETE FROM taggable WHERE workspace_id = $1::uuid`,
    `DELETE FROM tag WHERE workspace_id = $1::uuid`,
    `DELETE FROM comment_reaction WHERE workspace_id = $1::uuid`,
    `DELETE FROM naming_template WHERE workspace_id = $1::uuid`,
    `DELETE FROM experiment_envelope WHERE workspace_id = $1::uuid`,
    `DELETE FROM experiment WHERE workspace_id = $1::uuid`,
    `DELETE FROM tour_completion WHERE user_id IN (SELECT id FROM app_user WHERE org_id = (SELECT org_id FROM workspace WHERE id = $1::uuid))`,
    `DELETE FROM tour WHERE workspace_id = $1::uuid`,
    `DELETE FROM manual_entry_fact WHERE workspace_id = $1::uuid`,
    `DELETE FROM manual_entry_batch WHERE workspace_id = $1::uuid`,
    `DELETE FROM comment WHERE thread_id IN (SELECT id FROM thread WHERE workspace_id = $1::uuid)`,
    `DELETE FROM thread WHERE workspace_id = $1::uuid`,
    `DELETE FROM alert WHERE workspace_id = $1::uuid`,
    `DELETE FROM rule_state WHERE rule_id IN (SELECT id FROM pacing_rule WHERE workspace_id = $1::uuid)`,
    `DELETE FROM pacing_rule WHERE workspace_id = $1::uuid`,
    `DELETE FROM spend_fact WHERE workspace_id = $1::uuid`,
    `DELETE FROM kpi_fact WHERE workspace_id = $1::uuid`,
    `DELETE FROM projection_fact WHERE workspace_id = $1::uuid`,
    `DELETE FROM period_closure WHERE workspace_id = $1::uuid`,
    `DELETE FROM approval_decision WHERE request_id IN (SELECT id FROM approval_request WHERE workspace_id = $1::uuid)`,
    `DELETE FROM approval_request WHERE workspace_id = $1::uuid`,
    `DELETE FROM bulk_change WHERE workspace_id = $1::uuid`,
    `DELETE FROM approval_policy WHERE workspace_id = $1::uuid`,
    `UPDATE target SET current_version_id = NULL, draft_version_id = NULL WHERE workspace_id = $1::uuid`,
    `DELETE FROM target_version WHERE target_id IN (SELECT id FROM target WHERE workspace_id = $1::uuid)`,
    `DELETE FROM target WHERE workspace_id = $1::uuid`,
    `DELETE FROM envelope_lineage WHERE workspace_id = $1::uuid`,
    `UPDATE envelope SET current_version_id = NULL, draft_version_id = NULL, parent_id = NULL, period_id = NULL WHERE workspace_id = $1::uuid`,
    `DELETE FROM fiscal_period WHERE workspace_id = $1::uuid`,
    `DELETE FROM envelope_phasing WHERE version_id IN (SELECT id FROM envelope_version WHERE envelope_id IN ${envs})`,
    `DELETE FROM envelope_version WHERE envelope_id IN ${envs}`,
    `DELETE FROM envelope_allocation WHERE workspace_id = $1::uuid`,
    `DELETE FROM envelope_dimension WHERE envelope_id IN ${envs}`,
    `DELETE FROM envelope WHERE workspace_id = $1::uuid`,
    `DELETE FROM outbox WHERE workspace_id = $1::uuid`,
    `DELETE FROM hierarchy_template WHERE workspace_id = $1::uuid`,
    `DELETE FROM role_assignment WHERE workspace_id = $1::uuid`,
    `DELETE FROM ingest_run WHERE source_id IN (SELECT id FROM data_source WHERE workspace_id = $1::uuid)`,
    `DELETE FROM data_source WHERE workspace_id = $1::uuid`,
    `DELETE FROM mapping_synonym WHERE workspace_id = $1::uuid`,
    `DELETE FROM mapping_profile WHERE workspace_id = $1::uuid`,
  ]) {
    await owner.$executeRawUnsafe(sql, ws);
  }
  // W3-11 (audit I-32): audit_event.workspace_id is now a FK to workspace(id). audit_event is
  // append-only (audit_event_immutable trigger); disabled here for cleanup only, the same way
  // migration 20261010030000's one-time backfill does.
  await owner.$executeRawUnsafe(`ALTER TABLE audit_event DISABLE TRIGGER audit_event_immutable`);
  await owner.$executeRawUnsafe(`DELETE FROM audit_event WHERE workspace_id = $1::uuid`, ws);
  await owner.$executeRawUnsafe(`ALTER TABLE audit_event ENABLE TRIGGER audit_event_immutable`);
  await owner.$executeRawUnsafe(`DELETE FROM workspace WHERE id = $1::uuid`, ws);
}
