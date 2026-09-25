import type { PrismaClient } from "@prisma/client";
import type { GoldenResult } from "../seed/golden.js";

/**
 * Deletes a golden workspace a test seeded, and its org, as the owner role. One list for every
 * golden-based test: a new golden entity type (T-015 targets and metrics, …) is added once, here.
 * Statements for tables a test never wrote are no-ops.
 */
export async function cleanupGolden(owner: PrismaClient, golden: GoldenResult): Promise<void> {
  const ws = golden.workspaceId;
  const envs = `(SELECT id FROM envelope WHERE workspace_id = $1::uuid)`;
  for (const sql of [
    `DELETE FROM notification WHERE workspace_id = $1::uuid`,
    `DELETE FROM search_document WHERE workspace_id = $1::uuid`,
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
    `DELETE FROM envelope_dimension WHERE envelope_id IN ${envs}`,
    `DELETE FROM envelope WHERE workspace_id = $1::uuid`,
    `DELETE FROM outbox WHERE workspace_id = $1::uuid`,
    `DELETE FROM hierarchy_template WHERE workspace_id = $1::uuid`,
    `DELETE FROM role_assignment WHERE workspace_id = $1::uuid`,
    `DELETE FROM ingest_run WHERE source_id IN (SELECT id FROM data_source WHERE workspace_id = $1::uuid)`,
    `DELETE FROM data_source WHERE workspace_id = $1::uuid`,
  ]) {
    await owner.$executeRawUnsafe(sql, ws);
  }
  for (const sql of [
    `DELETE FROM metric_definition WHERE org_id = $1::uuid`,
    `DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE org_id = $1::uuid)`,
    `DELETE FROM dimension WHERE org_id = $1::uuid`,
    `DELETE FROM role_assignment WHERE principal_id IN (SELECT id FROM app_user WHERE org_id = $1::uuid)`,
    `DELETE FROM app_user WHERE org_id = $1::uuid`,
  ]) {
    await owner.$executeRawUnsafe(sql, golden.orgId);
  }
  await owner.$executeRawUnsafe(`DELETE FROM workspace WHERE id = $1::uuid`, ws);
  await owner.$executeRawUnsafe(`DELETE FROM organization WHERE id = $1::uuid`, golden.orgId);
}
