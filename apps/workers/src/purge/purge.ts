import { asOrgAdmin, withTenant, type TenantContext } from "@budget/db";
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
export const VIA_PARENT: Array<[table: string, sql: string]> = [
  ["comment_reaction", "DELETE FROM comment_reaction WHERE workspace_id = $1::uuid"],
  ["comment", "DELETE FROM comment WHERE thread_id IN (SELECT id FROM thread WHERE workspace_id = $1::uuid)"],
  ["approval_decision", "DELETE FROM approval_decision WHERE request_id IN (SELECT id FROM approval_request WHERE workspace_id = $1::uuid)"],
  ["envelope_phasing", "DELETE FROM envelope_phasing WHERE version_id IN (SELECT v.id FROM envelope_version v JOIN envelope e ON e.id = v.envelope_id WHERE e.workspace_id = $1::uuid)"],
  // W3-11 (audit I-32): envelope.current_version_id / draft_version_id and envelope.parent_id are
  // now FKs to envelope_version(id) and envelope(id) respectively. Each statement here runs in its
  // own transaction (see `run` below), so — unlike the DEFERRABLE INITIALLY DEFERRED on those FKs,
  // which only helps within a single transaction — the pointers must be cleared in a transaction of
  // their own before the rows they point at are deleted in a later one. parent_id is self-referencing
  // within one DELETE statement too: nulling it for every envelope in the workspace first means no
  // row is still pointed at by a sibling by the time the final DELETE FROM envelope runs, regardless
  // of the order Postgres deletes rows within that statement.
  ["envelope (clear version pointers)", "UPDATE envelope SET current_version_id = NULL, draft_version_id = NULL WHERE workspace_id = $1::uuid"],
  ["envelope (clear parent_id)", "UPDATE envelope SET parent_id = NULL WHERE workspace_id = $1::uuid"],
  ["envelope_version", "DELETE FROM envelope_version WHERE envelope_id IN (SELECT id FROM envelope WHERE workspace_id = $1::uuid)"],
  ["envelope_dimension", "DELETE FROM envelope_dimension WHERE envelope_id IN (SELECT id FROM envelope WHERE workspace_id = $1::uuid)"],
  ["closure_envelope", "DELETE FROM closure_envelope WHERE closure_id IN (SELECT id FROM period_closure WHERE workspace_id = $1::uuid)"],
  // Same reasoning as envelope's version pointers, for target.current_version_id / draft_version_id
  // -> target_version(id).
  ["target (clear version pointers)", "UPDATE target SET current_version_id = NULL, draft_version_id = NULL WHERE workspace_id = $1::uuid"],
  ["target_version", "DELETE FROM target_version WHERE target_id IN (SELECT id FROM target WHERE workspace_id = $1::uuid)"],
  ["rule_state", "DELETE FROM rule_state WHERE rule_id IN (SELECT id FROM pacing_rule WHERE workspace_id = $1::uuid)"],
  ["ingest_run", "DELETE FROM ingest_run WHERE source_id IN (SELECT id FROM data_source WHERE workspace_id = $1::uuid)"],
  ["tour_completion", "DELETE FROM tour_completion WHERE tour_id IN (SELECT id FROM tour WHERE workspace_id = $1::uuid)"],
  ["value_constraint", "DELETE FROM value_constraint WHERE dimension_id IN (SELECT id FROM dimension WHERE workspace_id = $1::uuid)"],
  // dimension_value.parent_value_id / merged_into_id are self-referencing (same single-DELETE-
  // statement reasoning as envelope.parent_id above).
  ["dimension_value (clear self-refs)", "UPDATE dimension_value SET parent_value_id = NULL, merged_into_id = NULL WHERE dimension_id IN (SELECT id FROM dimension WHERE workspace_id = $1::uuid)"],
  ["dimension_value", "DELETE FROM dimension_value WHERE dimension_id IN (SELECT id FROM dimension WHERE workspace_id = $1::uuid)"],
];

/** Tables with workspace_id, in an order that satisfies the foreign keys (children before parents). */
export const OWN = [
  "bulk_preview",
  "idempotency_key",
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
  "workspace_data_version",
  "search_document",
  "search_term",
  "alert",
  "pacing_rule",
  "data_source",
  "match_rule",
  "naming_convention",
  "mapping_synonym",
  "mapping_profile",
  "saved_view",
  "export_job",
  "notification",
  "subscription",
  "bulk_change",
  "slack_message",
  "slack_delivery",
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
  // envelope.parent_id and dimension_value's self-refs are already NULL (cleared above, W3-11);
  // envelope's other children are gone above too.
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

/**
 * W3-11 (audit I-32): test-only. Hard-deletes one or more workspaces and every row that FKs to
 * them, including the `workspace` row itself (unlike `purgeWorkspace`, which keeps `audit_event`
 * and the tombstone `workspace` row for the real purge flow — tests want a clean slate, not a
 * tombstone). Reuses the exact `VIA_PARENT`/`OWN` order `purgeWorkspace` validates against
 * production: those are the tables every tenant table's workspace_id (and the pointer columns)
 * now FKs to.
 *
 * W0-6: the owner has no BYPASSRLS (it matches production's real, non-superuser owner), so every
 * statement below needs the org-admin tenant context real writes get from `withTenant` — without
 * it, FORCE RLS silently deletes zero rows. `orgId` is the one org every workspace id here belongs
 * to (every caller cleans up workspaces from a single test org); `asOrgAdmin` wraps the whole
 * delete in one transaction with that context set transaction-locally, which also keeps the
 * surrounding `ALTER TABLE ... DISABLE/ENABLE TRIGGER` pair atomic with the deletes between them.
 * `audit_event` is append-only (the `audit_event_immutable` trigger); it is disabled around the
 * delete, test cleanup only, same as the real purge keeps it on but this never runs outside a test.
 *
 * W0-6: bundling every statement into one interactive transaction (for the org-admin context) is
 * new here — before, these ran as separate auto-committed statements with no shared deadline. A
 * large fixture (bulk.perf.test.ts's 10k envelopes and everything that cascades from them) can
 * genuinely take longer than Prisma's 30s default, so this raises it rather than risk a timeout
 * on every caller's much smaller case.
 */
export async function deleteWorkspaceForTests(prisma: PrismaClient, workspaceIds: string | readonly string[], orgId: string): Promise<void> {
  const ids = Array.isArray(workspaceIds) ? workspaceIds : [workspaceIds];
  if (ids.length === 0) return;
  await asOrgAdmin(
    prisma,
    async (tx) => {
      for (const id of ids) {
        for (const [, sql] of VIA_PARENT) await tx.$executeRawUnsafe(sql, id);
        for (const table of OWN) await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE workspace_id = $1::uuid`, id);
      }
      // outbox and audit_event are deliberately outside VIA_PARENT/OWN: purgeWorkspace keeps both
      // (the real purge never deletes the workspace row either, only tombstones it, so their FKs
      // to workspace(id) never bind there). A test hard-delete needs them gone first.
      await tx.$executeRawUnsafe(`DELETE FROM processed_event WHERE outbox_id IN (SELECT id FROM outbox WHERE workspace_id = ANY($1::uuid[]))`, ids);
      await tx.$executeRawUnsafe(`DELETE FROM outbox WHERE workspace_id = ANY($1::uuid[])`, ids);
      await tx.$executeRawUnsafe(`ALTER TABLE audit_event DISABLE TRIGGER audit_event_immutable`);
      await tx.$executeRawUnsafe(`DELETE FROM audit_event WHERE workspace_id = ANY($1::uuid[])`, ids);
      await tx.$executeRawUnsafe(`ALTER TABLE audit_event ENABLE TRIGGER audit_event_immutable`);
      await tx.$executeRawUnsafe(`DELETE FROM workspace WHERE id = ANY($1::uuid[])`, ids);
    },
    orgId,
    { timeoutMs: 90_000 },
  );
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
