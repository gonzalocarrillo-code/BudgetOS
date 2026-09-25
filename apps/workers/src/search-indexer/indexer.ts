import { deleteSearchDocuments, loadBulkChange, searchDocumentIds, upsertSearchDocuments, withTenant, type TenantContext, type Tx } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { decodePush, handleOnce, type OutboxEvent } from "../consumer.js";
import { log } from "../log.js";
import { BUILDERS, type IndexContext, type IndexedType } from "./documents.js";

/**
 * search-indexer (spec §12.1): a Pub/Sub push subscriber for every outbox topic. Each event names
 * the entities it touched; their documents are rebuilt in the event's transaction, once per
 * outbox id (processed_event). Topics that touch nothing searchable are acknowledged and skipped.
 */

export const SEARCH_CONSUMER = "search-indexer";
type Targets = Partial<Record<IndexedType, string[]>>;

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : []);
const add = (t: Targets, type: IndexedType, ids: string[]) => {
  if (ids.length) t[type] = [...new Set([...(t[type] ?? []), ...ids])];
};

/** Which documents an outbox event invalidates. */
export async function targetsFor(tx: Tx, topic: string, payload: Record<string, unknown>): Promise<Targets> {
  const t: Targets = {};
  switch (topic) {
    case "budget.changed": {
      add(t, "envelope", [...strs(payload["envelopeId"]), ...strs(payload["sourceIds"]), ...strs(payload["targetId"]), ...strs(payload["sourceId"]), ...strs(payload["partIds"])]);
      const versionIds = strs(payload["versionIds"]);
      if (versionIds.length) add(t, "envelope", (await tx.envelopeVersion.findMany({ where: { id: { in: versionIds } }, select: { envelopeId: true } })).map((v) => v.envelopeId));
      const bulkId = strs(payload["bulkChangeId"])[0];
      if (bulkId) {
        const bulk = await loadBulkChange(tx, bulkId);
        if (bulk) add(t, "envelope", (await tx.envelopeVersion.findMany({ where: { id: { in: bulk.versionIds } }, select: { envelopeId: true } })).map((v) => v.envelopeId));
      }
      add(t, "approval_request", strs(payload["requestId"]));
      break;
    }
    case "facts.loaded":
      add(t, "envelope", strs(payload["envelopeIds"]));
      break;
    case "period.closed":
    case "period.restated": {
      // Closing and restating change the status of every envelope the closure locked.
      const closureId = strs(payload["closureId"])[0];
      if (closureId) add(t, "envelope", (await tx.closureEnvelope.findMany({ where: { closureId }, select: { envelopeId: true } })).map((c) => c.envelopeId));
      break;
    }
    case "target.changed":
      add(t, "target", strs(payload["targetId"]));
      break;
    case "approval.changed":
      add(t, "approval_request", strs(payload["requestId"]));
      break;
    case "alert.triggered":
    case "alert.changed":
      add(t, "alert", strs(payload["alertId"]));
      break;
    case "thread.changed": {
      add(t, "comment", strs(payload["commentId"]));
      // Resolve / reopen changes every comment's status.
      if (payload["action"] === "thread.resolved" || payload["action"] === "thread.reopened") {
        add(t, "comment", (await tx.comment.findMany({ where: { threadId: strs(payload["threadId"])[0] ?? "" }, select: { id: true } })).map((c) => c.id));
      }
      break;
    }
    case "tag.changed": {
      const tagId = strs(payload["tagId"])[0];
      const from = payload["mergedFrom"] as { id?: string } | undefined;
      add(t, "tag", [...strs(tagId), ...strs(from?.id)]);
      const entities = Array.isArray(payload["entities"]) ? (payload["entities"] as Array<{ type: string; id: string }>) : [];
      const current = tagId ? await tx.taggable.findMany({ where: { tagId }, select: { entityType: true, entityId: true } }) : [];
      for (const e of [...entities, ...current.map((c) => ({ type: c.entityType, id: c.entityId }))]) {
        if (e.type === "envelope" || e.type === "target" || e.type === "alert" || e.type === "approval_request") add(t, e.type, [e.id]);
      }
      break;
    }
    case "registry.changed":
      add(t, "dimension_value", strs(payload["dimensionId"]));
      add(t, "envelope", strs(payload["envelopeIds"]));
      break;
    default:
      break;
  }
  return t;
}

/** Rebuilds the documents of the given entities (dimension values: of the given dimensions). */
export async function indexEntities(tx: Tx, ctx: IndexContext, targets: Targets): Promise<{ upserted: number; deleted: number }> {
  let upserted = 0;
  let deleted = 0;
  for (const [type, ids] of Object.entries(targets) as Array<[IndexedType, string[]]>) {
    for (let i = 0; i < ids.length; i += 1000) {
      const built = await BUILDERS[type](tx, ctx, ids.slice(i, i + 1000));
      upserted += await upsertSearchDocuments(tx, built.upserts);
      if (type !== "dimension_value") deleted += await deleteSearchDocuments(tx, ctx.workspaceId, type, built.deletes);
    }
  }
  return { upserted, deleted };
}

const systemCtx = (workspaceId: string, orgId: string, requestId: string): TenantContext => ({ workspaceId, orgId, userId: null, isOrgAdmin: false, actorType: "system", requestId });

/** Push handler: one outbox event → the documents it touched, once. */
export async function handleSearchEvent(prisma: PrismaClient, body: unknown, today = new Date().toISOString().slice(0, 10)) {
  const event: OutboxEvent = decodePush(body);
  let counts = { upserted: 0, deleted: 0 };
  const outcome = await handleOnce(prisma, SEARCH_CONSUMER, event, async (tx) => {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const targets = await targetsFor(tx, event.topic, payload);
    counts = await indexEntities(tx, { workspaceId: event.workspaceId, orgId: event.orgId, today }, targets);
  });
  return { outcome, ...counts };
}

/**
 * Full re-index of a workspace (spec §12.1 `reindex`): every entity type in batches of 1,000, and
 * documents whose entity no longer exists are removed.
 */
export async function reindexWorkspace(prisma: PrismaClient, tenant: { workspaceId: string; orgId: string }, today = new Date().toISOString().slice(0, 10)) {
  const ctx: IndexContext = { ...tenant, today };
  const counts: Record<string, number> = {};
  for (const type of Object.keys(BUILDERS) as IndexedType[]) {
    await withTenant(
      prisma,
      systemCtx(tenant.workspaceId, tenant.orgId, `reindex-${type}-${tenant.workspaceId}`),
      async (tx) => {
        const built = await BUILDERS[type](tx, ctx, null);
        for (let i = 0; i < built.upserts.length; i += 1000) await upsertSearchDocuments(tx, built.upserts.slice(i, i + 1000));
        const keep = new Set(built.upserts.map((d) => d.entityId));
        const existing = await searchDocumentIds(tx, tenant.workspaceId, type);
        await deleteSearchDocuments(tx, tenant.workspaceId, type, existing.filter((id) => !keep.has(id)));
        counts[type] = built.upserts.length;
      },
      { timeoutMs: 300_000 },
    );
  }
  log.info({ workspaceId: tenant.workspaceId, counts }, "search re-index finished");
  return counts;
}
