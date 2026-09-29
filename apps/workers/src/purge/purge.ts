import { withTenant, type TenantContext } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { log } from "../log.js";

/**
 * The workspace purge (ADR-052): after a superadmin deleted a workspace and its retention window
 * passed, remove the workspace's own rows, child tables first. It runs as the app role inside the
 * workspace's own tenant session, so RLS keeps every statement to that workspace. It keeps the
 * `audit_event` rows and the tombstone `workspace` row (the org's audit trail still resolves the
 * id) and the transient outbox. Each table is its own statement and transaction, so a large
 * workspace never holds one long transaction, and a rerun after a failure picks up where it
 * stopped: every statement is idempotent.
 */

/** Child tables without workspace_id, deleted through their parent (the parent is still there). */
const VIA_PARENT: Array<[table: string, sql: string]> = [
  ["comment_reaction", "DELETE FROM comment_reaction WHERE workspace_id = $1::uuid"],
  ["comment", "DELETE FROM comment WHERE thread_id IN (SELECT id FROM thread WHERE workspace_id = $1::uuid)"],
  ["approval_decision", "DELETE FROM approval_decision WHERE request_id IN (SELECT id FROM approval_request WHERE workspace_id = $1::uuid)"],
  ["envelope_phasing", "DELETE FROM envelope_phasing WHERE version_id IN (SELECT v.id FROM envelope_version v JOIN envelope e ON e.id = v.envelope_id WHERE e.workspace_id = $1::uuid)"],
  ["envelope_version", "DELETE FROM envelope_version WHERE envelope_id IN (SELECT id FROM envelope WHERE workspace_id = $1::uuid)"],
  ["envelope_dimension", "DELETE FROM envelope_dimension WHERE envelope_id IN (SELECT id FROM envelope WHERE workspace_id = $1::uuid)"],
  ["closure_envelope", "DELETE FROM closure_envelope WHERE closure_id IN (SELECT id FROM period_closure WHERE workspace_id = $1::uuid)"],
  ["target_version", "DELETE FROM target_version WHERE target_id IN (SELECT id FROM target WHERE workspace_id = $1::uuid)"],
  ["rule_state", "DELETE FROM rule_state WHERE rule_id IN (SELECT id FROM pacing_rule WHERE workspace_id = $1::uuid)"],
  ["ingest_run", "DELETE FROM ingest_run WHERE source_id IN (SELECT id FROM data_source WHERE workspace_id = $1::uuid)"],
  ["tour_completion", "DELETE FROM tour_completion WHERE tour_id IN (SELECT id FROM tour WHERE workspace_id = $1::uuid)"],
  ["value_constraint", "DELETE FROM value_constraint WHERE dimension_id IN (SELECT id FROM dimension WHERE workspace_id = $1::uuid)"],
  ["dimension_value", "DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE workspace_id = $1::uuid)"],
];

/** Tables with workspace_id, in an order that satisfies the foreign keys (children before parents). */
const OWN = [
  "budget_baseline_row",
  "budget_baseline",
  "thread",
  "approval_request",
  "taggable",
  "tag",
  "envelope_allocation",
  "envelope_lineage",
  "experiment_envelope",
  "experiment",
  "period_closure",
  "target",
  "manual_entry_fact",
  "manual_entry_batch",
  "spend_fact",
  "kpi_fact",
  "projection_fact",
  "spend_month",
  "rollup_cache",
  "search_document",
  "search_term",
  "alert",
  "pacing_rule",
  "data_source",
  "saved_view",
  "export_job",
  "notification",
  "subscription",
  "bulk_change",
  "slack_message",
  "fiscal_period",
  "naming_template",
  "hierarchy_template",
  "approval_policy",
  "tour",
  "dimension",
  "metric_definition",
  "role_assignment",
  "envelope",
] as const;

export async function purgeWorkspace(prisma: PrismaClient, ws: { workspaceId: string; orgId: string }, now: Date = new Date()): Promise<Record<string, number>> {
  const ctx: TenantContext = { workspaceId: ws.workspaceId, orgId: ws.orgId, userId: null, isOrgAdmin: false, actorType: "system", requestId: `purge-${ws.workspaceId}` };
  const counts: Record<string, number> = {};
  const run = async (table: string, sql: string) => {
    counts[table] = await withTenant(prisma, ctx, (tx) => tx.$executeRawUnsafe(sql, ws.workspaceId), { timeoutMs: 300_000 });
  };
  for (const [table, sql] of VIA_PARENT) await run(table, sql);
  // envelope's self reference is ON DELETE SET NULL; its other children are gone above.
  for (const table of OWN) await run(table, `DELETE FROM ${table} WHERE workspace_id = $1::uuid`);
  await withTenant(prisma, { ...ctx, isOrgAdmin: true }, async (tx) => {
    await tx.workspace.update({ where: { id: ws.workspaceId }, data: { purgedAt: now } });
    await tx.$executeRaw`INSERT INTO audit_event (workspace_id, actor_id, actor_type, action, entity_type, entity_id, before, after, request_id)
      VALUES (${ws.workspaceId}::uuid, NULL, 'system', 'workspace.purged', 'workspace', ${ws.workspaceId}::uuid, 'null'::jsonb, ${JSON.stringify(counts)}::jsonb, ${ctx.requestId})`;
    await tx.$executeRaw`INSERT INTO outbox (workspace_id, topic, payload) VALUES (${ws.workspaceId}::uuid, 'workspace.purged', ${JSON.stringify({ workspaceId: ws.workspaceId })}::jsonb)`;
  });
  log.info({ workspaceId: ws.workspaceId, orgId: ws.orgId, requestId: ctx.requestId, counts }, "workspace purged");
  return counts;
}

/** Every deleted workspace of these orgs whose retention window has passed and is not purged yet. */
export async function purgeDueWorkspaces(prisma: PrismaClient, orgIds: readonly string[], now: Date = new Date()): Promise<string[]> {
  const done: string[] = [];
  for (const orgId of orgIds) {
    const due = await withTenant(prisma, { workspaceId: null, orgId, userId: null, isOrgAdmin: true, actorType: "system", requestId: `purge-scan-${orgId}` }, (tx) =>
      tx.workspace.findMany({ where: { orgId, deletedAt: { not: null }, purgedAt: null, purgeAfter: { lte: now } }, select: { id: true } }),
    );
    for (const w of due) {
      try {
        await purgeWorkspace(prisma, { workspaceId: w.id, orgId }, now);
        done.push(w.id);
      } catch (err) {
        // The next run resumes: every statement is idempotent.
        log.error({ err, workspaceId: w.id, orgId }, "workspace purge failed");
      }
    }
  }
  return done;
}
