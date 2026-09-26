import { CreateSourceInput, CreateUploadInput, DomainError, MapUnmatchedInput, RunSourceInput, UpdateSourceInput, newId, type SourceConfig, type SourceMapping } from "@budget/domain";
import { assignUnmatched, audit, bumpDataVersion, outbox, withTenant, type Tx } from "@budget/db";
import { uploadBucket, type ObjectStore } from "@budget/workers";
import type { DataSource, Prisma, PrismaClient } from "@prisma/client";
import { parseId, parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";

/** Data sources, runs and the unmatched queue (spec §14, §17 `sources`). One audit_event + one outbox row per write. */

const json = (v: unknown) => v as Prisma.InputJsonValue;

export function sourceView(s: DataSource) {
  return { id: s.id, workspaceId: s.workspaceId, kind: s.kind, name: s.name, config: s.config, mapping: s.mapping, schedule: s.schedule, isActive: s.isActive };
}

async function recordSourceChange(tx: Tx, auth: AuthContext, args: { workspaceId: string; action: string; sourceId: string; before?: unknown; after: Record<string, unknown> }) {
  await audit(tx, { workspaceId: args.workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: args.action, entityType: "data_source", entityId: args.sourceId, before: args.before ?? null, after: args.after, requestId: auth.ctx.requestId });
  await outbox(tx, { workspaceId: args.workspaceId, topic: "source.changed", payload: { sourceId: args.sourceId, action: args.action, ...args.after } });
}

/** A csv source reads only this workspace's uploads (ADR-011). */
function checkConfig(config: SourceConfig, workspaceId: string): void {
  if (config.kind === "csv" && !config.uri.startsWith(`gs://${uploadBucket()}/uploads/${workspaceId}/`)) {
    throw new DomainError("VALIDATION", "A csv source must point at this workspace's uploads", { expectedPrefix: `gs://${uploadBucket()}/uploads/${workspaceId}/` });
  }
}

/** Every dimension the mapping names exists in the registry the workspace sees. */
async function checkMapping(tx: Tx, auth: AuthContext, workspaceId: string, mapping: SourceMapping): Promise<void> {
  const keys = [...new Set(Object.values(mapping.columns).flatMap((c) => ("dimension" in c ? [c.dimension] : [])))];
  const found = await tx.dimension.findMany({ where: { orgId: auth.user.orgId, isActive: true, key: { in: keys }, OR: [{ workspaceId: null }, { workspaceId }] }, select: { key: true } });
  const missing = keys.filter((k) => !found.some((d) => d.key === k));
  if (missing.length) throw new DomainError("VALIDATION", "The mapping names dimensions the registry does not have", { missing });
}

/** POST /workspaces/:ws/sources. */
export async function createSource(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = parseInput(CreateSourceInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  checkConfig(input.config, workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    await checkMapping(tx, auth, workspaceId, input.mapping);
    const row = await tx.dataSource.create({ data: { id: newId(), workspaceId, kind: input.config.kind, name: input.name, config: json(input.config), mapping: json(input.mapping), schedule: input.schedule ?? null } });
    await recordSourceChange(tx, auth, { workspaceId, action: "source.created", sourceId: row.id, after: { kind: row.kind, name: row.name } });
    return sourceView(row);
  });
}

async function loadSource(tx: Tx, rawId: string): Promise<DataSource> {
  const s = await tx.dataSource.findUnique({ where: { id: parseId(rawId) } });
  if (s === null) throw new DomainError("NOT_FOUND", "Source not found");
  return s;
}

/** PATCH /sources/:id. Config rows are audited with before/after; the kind never changes. */
export async function updateSource(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const input = parseInput(UpdateSourceInput, raw);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const current = await loadSource(tx, rawId);
    if (input.config && input.config.kind !== current.kind) throw new DomainError("VALIDATION", "A source keeps its kind; create a new source instead", { kind: current.kind });
    if (input.config) checkConfig(input.config, current.workspaceId);
    if (input.mapping) await checkMapping(tx, auth, current.workspaceId, input.mapping);
    const row = await tx.dataSource.update({
      where: { id: current.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.config !== undefined ? { config: json(input.config) } : {}),
        ...(input.mapping !== undefined ? { mapping: json(input.mapping) } : {}),
        ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    await recordSourceChange(tx, auth, { workspaceId: row.workspaceId, action: "source.updated", sourceId: row.id, before: sourceView(current), after: { changed: Object.keys(input) } });
    return sourceView(row);
  });
}

/**
 * POST /sources/:id/run: queues a run for the ingest worker (never runs it in the request, ADR-011).
 * `restatementOf` lets the run load facts into that closed closure's period (spec §15).
 */
export async function queueRun(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown = {}) {
  const input = parseInput(RunSourceInput, raw ?? {});
  return withTenant(prisma, auth.ctx, async (tx) => {
    const source = await loadSource(tx, rawId);
    if (!source.isActive) throw new DomainError("CONFLICT", "Source is inactive");
    const open = await tx.ingestRun.findFirst({ where: { sourceId: source.id, status: { in: ["queued", "running"] } }, select: { id: true, status: true } });
    if (open) throw new DomainError("CONFLICT", `A run is already ${open.status}`, { runId: open.id });
    if (input.restatementOf) {
      const closure = await tx.periodClosure.findUnique({ where: { id: input.restatementOf }, select: { workspaceId: true, status: true } });
      if (closure === null || closure.workspaceId !== source.workspaceId) throw new DomainError("NOT_FOUND", "Closure not found");
      if (closure.status !== "closed") throw new DomainError("CONFLICT", "The closure is already restated; its period accepts facts");
    }
    const restatement = input.restatementOf ? { restatementOf: input.restatementOf } : {};
    const run = await tx.ingestRun.create({ data: { id: newId(), sourceId: source.id, status: "queued", summary: restatement } });
    await audit(tx, { workspaceId: source.workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "ingest.run.queued", entityType: "ingest_run", entityId: run.id, after: { sourceId: source.id, ...restatement }, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId: source.workspaceId, topic: "ingest.requested", payload: { runId: run.id, sourceId: source.id } });
    return { runId: run.id, sourceId: source.id, status: run.status };
  });
}

/** POST /workspaces/:ws/unmatched-spend/map: the tuple's unmatched facts go to the envelope. */
export async function mapUnmatched(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = parseInput(MapUnmatchedInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const env = await tx.envelope.findUnique({ where: { id: input.envelopeId } });
    if (env === null || env.workspaceId !== workspaceId) throw new DomainError("NOT_FOUND", "Envelope not found");
    if (env.status === "ARCHIVED") throw new DomainError("CONFLICT", "Envelope is archived");
    const assigned = await assignUnmatched(tx, workspaceId, input.dimensionValues, { id: env.id, startDate: env.startDate.toISOString().slice(0, 10), endDate: env.endDate.toISOString().slice(0, 10) });
    if (assigned.spend + assigned.kpi + assigned.projection === 0) throw new DomainError("NOT_FOUND", "No unmatched facts with this tuple inside the envelope's dates");
    await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "facts.mapped", entityType: "envelope", entityId: env.id, after: { dimensionValues: input.dimensionValues, ...assigned }, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId, topic: "facts.loaded", payload: { envelopeIds: [env.id], mapped: assigned, dimensionValues: input.dimensionValues } });
    await bumpDataVersion(tx, workspaceId);
    return { envelopeId: env.id, ...assigned };
  });
}

/** POST /uploads: where to send a CSV (and with which method), and the gs:// URI a csv source then points at. */
export async function createUpload(store: ObjectStore, auth: AuthContext, raw: unknown) {
  const input = parseInput(CreateUploadInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const uri = `gs://${uploadBucket()}/uploads/${workspaceId}/${newId()}-${input.filename.replace(/\s+/g, "_")}`;
  const ttl = 15 * 60;
  return { uri, uploadUrl: await store.uploadUrl(uri, "text/csv", ttl), method: store.uploadMethod ?? "PUT", contentType: "text/csv", expiresInSeconds: ttl };
}
