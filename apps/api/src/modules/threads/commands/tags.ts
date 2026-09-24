import { ApplyTagInput, CreateTagInput, DomainError, UpdateTagInput, canInScope, newId } from "@budget/domain";
import { audit, mergeTag, outbox, withTenant, type Tx } from "@budget/db";
import type { PrismaClient, Tag } from "@prisma/client";
import { parseId, parseInput, requireWorkspace } from "../../../common/parse-input.js";
import { envelopeScopeTargets } from "../../../common/scope.guard.js";
import type { AuthContext } from "../../../common/tenant.js";

/** Tags (spec §13). Every write: one audit_event + one `tag.changed` outbox row (the search indexer refreshes). */

export const tagView = (t: Tag) => ({ id: t.id, name: t.name, color: t.color, kind: t.kind });

async function record(tx: Tx, auth: AuthContext, workspaceId: string, tagId: string, action: string, after: Record<string, unknown>, before: unknown = null) {
  await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action, entityType: "tag", entityId: tagId, before, after, requestId: auth.ctx.requestId });
  await outbox(tx, { workspaceId, topic: "tag.changed", payload: { tagId, action, ...after } });
}

/** POST /workspaces/:ws/tags */
export async function createTag(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = parseInput(CreateTagInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const clash = await tx.tag.findUnique({ where: { workspaceId_name: { workspaceId, name: input.name } }, select: { id: true } });
    if (clash) throw new DomainError("CONFLICT", "A tag with this name exists", { tagId: clash.id });
    const tag = await tx.tag.create({ data: { id: newId(), workspaceId, name: input.name, color: input.color ?? null, kind: input.kind, createdBy: auth.user.id } });
    await record(tx, auth, workspaceId, tag.id, "tag.created", tagView(tag));
    return tagView(tag);
  });
}

/** PATCH /tags/:id: rename / recolour, or `{ mergeIntoId }`: the tag's entities move to that tag and the tag goes. */
export async function updateTag(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const id = parseId(rawId);
  const input = parseInput(UpdateTagInput, raw);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const tag = await tx.tag.findUnique({ where: { id } });
    if (tag === null) throw new DomainError("NOT_FOUND", "Tag not found");
    if (input.mergeIntoId) {
      if (input.mergeIntoId === id) throw new DomainError("VALIDATION", "A tag cannot merge into itself");
      const into = await tx.tag.findUnique({ where: { id: input.mergeIntoId } });
      if (into === null || into.workspaceId !== tag.workspaceId) throw new DomainError("NOT_FOUND", "Merge target not found");
      const moved = await mergeTag(tx, id, into.id);
      await record(tx, auth, tag.workspaceId, into.id, "tag.merged", { mergedFrom: tagView(tag), moved }, tagView(tag));
      return { ...tagView(into), mergedFrom: id, moved };
    }
    if (input.name && input.name !== tag.name) {
      const clash = await tx.tag.findUnique({ where: { workspaceId_name: { workspaceId: tag.workspaceId, name: input.name } }, select: { id: true } });
      if (clash) throw new DomainError("CONFLICT", "A tag with this name exists", { tagId: clash.id });
    }
    const row = await tx.tag.update({
      where: { id },
      data: { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.color !== undefined ? { color: input.color } : {}), ...(input.kind !== undefined ? { kind: input.kind } : {}) },
    });
    await record(tx, auth, tag.workspaceId, id, "tag.updated", tagView(row), tagView(tag));
    return tagView(row);
  });
}

/** Every entity exists in the workspace, and envelopes are inside the caller's tag.apply scope. */
async function checkEntities(tx: Tx, auth: AuthContext, workspaceId: string, entities: ApplyTagInput["entities"]): Promise<void> {
  const byType = new Map<string, string[]>();
  for (const e of entities) byType.set(e.type, [...(byType.get(e.type) ?? []), e.id]);
  const found = new Set<string>();
  const where = (ids: string[]) => ({ id: { in: ids }, workspaceId });
  for (const [type, ids] of byType) {
    const rows =
      type === "envelope" ? await tx.envelope.findMany({ where: where(ids), select: { id: true } })
      : type === "target" ? await tx.target.findMany({ where: where(ids), select: { id: true } })
      : type === "alert" ? await tx.alert.findMany({ where: where(ids), select: { id: true } })
      : type === "approval_request" ? await tx.approvalRequest.findMany({ where: where(ids), select: { id: true } })
      : await tx.thread.findMany({ where: where(ids), select: { id: true } });
    for (const r of rows) found.add(`${type}:${r.id}`);
  }
  const missing = entities.filter((e) => !found.has(`${e.type}:${e.id}`));
  if (missing.length) throw new DomainError("VALIDATION", "Some entities do not exist in this workspace", { missing: missing.slice(0, 50), count: missing.length });
  if (auth.isOrgAdmin) return;
  const scopes = await envelopeScopeTargets(tx, byType.get("envelope") ?? []);
  const outside = [...scopes.entries()].filter(([, t]) => !canInScope(auth.assignments, "tag.apply", t)).map(([id]) => id);
  if (outside.length) throw new DomainError("FORBIDDEN", "Some envelopes are outside your scope", { outside: outside.slice(0, 50), count: outside.length });
}

/** POST /tags/apply (add) and DELETE /tags/apply (remove), up to 10k entities in one statement. */
export async function applyTag(prisma: PrismaClient, auth: AuthContext, raw: unknown, mode: "add" | "remove") {
  const input = parseInput(ApplyTagInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(
    prisma,
    auth.ctx,
    async (tx) => {
      const tag = await tx.tag.findUnique({ where: { id: input.tagId } });
      if (tag === null || tag.workspaceId !== workspaceId) throw new DomainError("NOT_FOUND", "Tag not found");
      await checkEntities(tx, auth, workspaceId, input.entities);
      const changed =
        mode === "add"
          ? (await tx.taggable.createMany({ data: input.entities.map((e) => ({ workspaceId, tagId: tag.id, entityType: e.type, entityId: e.id, taggedBy: auth.user.id })), skipDuplicates: true })).count
          : (await tx.taggable.deleteMany({ where: { tagId: tag.id, OR: input.entities.map((e) => ({ entityType: e.type, entityId: e.id })) } })).count;
      await record(tx, auth, workspaceId, tag.id, mode === "add" ? "tag.applied" : "tag.removed", { changed, entities: input.entities });
      return { tagId: tag.id, requested: input.entities.length, changed };
    },
    { timeoutMs: 60_000 },
  );
}

/** GET /workspaces/:ws/tags: with how many entities carry each. */
export function listTags(prisma: PrismaClient, auth: AuthContext) {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const tags = await tx.tag.findMany({ where: { workspaceId }, orderBy: { name: "asc" } });
    const counts = await tx.taggable.groupBy({ by: ["tagId"], where: { workspaceId }, _count: { _all: true } });
    return tags.map((t) => ({ ...tagView(t), count: counts.find((c) => c.tagId === t.id)?._count._all ?? 0 }));
  });
}
