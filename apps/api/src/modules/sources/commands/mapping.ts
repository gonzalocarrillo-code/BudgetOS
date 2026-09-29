import { CreateMappingProfileInput, CreateMappingSynonymInput, DomainError, UpdateMappingProfileInput, UpdateMappingSynonymInput, newId, normTerm, type ColumnMapping, type ColumnSynonymTarget, type SourceMapping } from "@budget/domain";
import { audit, outbox, withTenant, type Tx } from "@budget/db";
import type { MappingProfile, Prisma, PrismaClient } from "@prisma/client";
import { parseId, parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { profileView } from "../queries/mapping.js";

/**
 * Mapping profiles and synonyms (docs/DATA_PLAN.md §2.3, D-004 and D-005). A profile is a named
 * mapping a workspace reuses; a source that follows one takes its mapping from it, and a change to
 * the profile reaches those sources in the same transaction. Synonyms are the workspace's words
 * for columns and metrics; every mapping saved teaches them. One audit_event and one outbox row
 * per write.
 */
const json = (v: unknown) => v as Prisma.InputJsonValue;

async function record(tx: Tx, auth: AuthContext, a: { workspaceId: string; action: string; entityType: string; entityId: string; before?: unknown; after: Record<string, unknown>; topic: string }) {
  await audit(tx, { workspaceId: a.workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: a.action, entityType: a.entityType, entityId: a.entityId, before: a.before ?? null, after: a.after, requestId: auth.ctx.requestId });
  await outbox(tx, { workspaceId: a.workspaceId, topic: a.topic, payload: { id: a.entityId, action: a.action, ...a.after } });
}

/** A column mapping as a synonym target: the role or dimension, without file-specific details (formats, currencies). */
function synonymTarget(c: ColumnMapping): ColumnSynonymTarget | null {
  if ("dimension" in c) return { dimension: c.dimension };
  if (c.role === "ignore") return null;
  if (c.role === "kpi" || c.role === "projection") return { role: c.role, metric: c.metric };
  return { role: c.role };
}

/**
 * D-005: every column a person maps teaches the workspace that word. A learned row follows the
 * latest mapping and counts its uses; a manual row is never overwritten by what is learned.
 */
export async function learnSynonyms(tx: Tx, auth: AuthContext, workspaceId: string, mapping: SourceMapping): Promise<number> {
  let learned = 0;
  for (const [header, c] of Object.entries(mapping.columns)) {
    const target = synonymTarget(c);
    const term = normTerm(header);
    if (target === null || term === "") continue;
    const existing = await tx.mappingSynonym.findUnique({ where: { workspaceId_kind_term: { workspaceId, kind: "column", term } } });
    if (existing === null) {
      await tx.mappingSynonym.create({ data: { id: newId(), workspaceId, kind: "column", term, target: json(target), origin: "learned", createdBy: auth.user.id } });
      learned += 1;
    } else if (existing.origin === "learned") {
      await tx.mappingSynonym.update({ where: { id: existing.id }, data: { target: json(target), uses: { increment: 1 }, updatedAt: new Date() } });
    }
  }
  return learned;
}

/** Sources that follow a profile take its mapping and parse pattern. */
async function syncFollowers(tx: Tx, auth: AuthContext, profile: MappingProfile): Promise<number> {
  const followers = await tx.dataSource.findMany({ where: { mappingProfileId: profile.id } });
  for (const s of followers) {
    await tx.dataSource.update({ where: { id: s.id }, data: { mapping: json(profile.mapping), parsePattern: profile.parsePattern } });
    await record(tx, auth, { workspaceId: s.workspaceId, action: "source.updated", entityType: "data_source", entityId: s.id, before: { mapping: s.mapping }, after: { changed: ["mapping"], fromProfile: profile.id }, topic: "source.changed" });
  }
  return followers.length;
}

/** POST /workspaces/:ws/mapping-profiles. */
export async function createMappingProfile(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = parseInput(CreateMappingProfileInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const unmapped = input.header.filter((h) => !(h in input.mapping.columns));
  if (unmapped.length) throw new DomainError("VALIDATION", "Every column of the file needs a mapping (ignore it if it is not needed)", { unmapped });
  return withTenant(prisma, auth.ctx, async (tx) => {
    if (await tx.mappingProfile.findUnique({ where: { workspaceId_name: { workspaceId, name: input.name } } })) throw new DomainError("CONFLICT", `A profile named "${input.name}" exists`);
    const row = await tx.mappingProfile.create({ data: { id: newId(), workspaceId, name: input.name, kind: input.mapping.kind, mapping: json(input.mapping), parsePattern: input.parsePattern ?? null, header: input.header, createdBy: auth.user.id } });
    await learnSynonyms(tx, auth, workspaceId, input.mapping);
    await record(tx, auth, { workspaceId, action: "mapping_profile.created", entityType: "mapping_profile", entityId: row.id, after: { name: row.name, kind: row.kind, columns: input.header.length }, topic: "mapping_profile.changed" });
    return profileView(row, 0);
  });
}

/** PATCH /mapping-profiles/:id: rename, remap (reaching its sources), archive or restore. */
export async function updateMappingProfile(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const id = parseId(rawId);
  const input = parseInput(UpdateMappingProfileInput, raw);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const before = await tx.mappingProfile.findUnique({ where: { id } });
    if (before === null) throw new DomainError("NOT_FOUND", "Mapping profile not found");
    if (input.name && input.name !== before.name && (await tx.mappingProfile.findUnique({ where: { workspaceId_name: { workspaceId: before.workspaceId, name: input.name } } }))) {
      throw new DomainError("CONFLICT", `A profile named "${input.name}" exists`);
    }
    const row = await tx.mappingProfile.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.mapping !== undefined ? { mapping: json(input.mapping), kind: input.mapping.kind } : {}),
        ...(input.parsePattern !== undefined ? { parsePattern: input.parsePattern } : {}),
        ...(input.archived !== undefined ? { archivedAt: input.archived ? new Date() : null } : {}),
        updatedAt: new Date(),
      },
    });
    const synced = input.mapping !== undefined || input.parsePattern !== undefined ? await syncFollowers(tx, auth, row) : 0;
    if (input.mapping) await learnSynonyms(tx, auth, row.workspaceId, input.mapping);
    await record(tx, auth, { workspaceId: row.workspaceId, action: "mapping_profile.updated", entityType: "mapping_profile", entityId: row.id, before: { name: before.name, mapping: before.mapping, archivedAt: before.archivedAt }, after: { changed: Object.keys(input), sourcesUpdated: synced }, topic: "mapping_profile.changed" });
    return profileView(row, await tx.dataSource.count({ where: { mappingProfileId: row.id } }));
  });
}

/** The profile a source will follow: this workspace's and not archived. */
export async function profileForSource(tx: Tx, workspaceId: string, profileId: string): Promise<MappingProfile> {
  const p = await tx.mappingProfile.findUnique({ where: { id: profileId } });
  if (p === null || p.workspaceId !== workspaceId) throw new DomainError("NOT_FOUND", "Mapping profile not found");
  if (p.archivedAt) throw new DomainError("CONFLICT", "The mapping profile is archived");
  return p;
}

/** POST /workspaces/:ws/mapping-synonyms: a word the workspace uses (a manual row wins over learned ones). */
export async function createMappingSynonym(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = parseInput(CreateMappingSynonymInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const term = normTerm(input.term);
  if (term === "") throw new DomainError("VALIDATION", "The word needs letters or digits");
  return withTenant(prisma, auth.ctx, async (tx) => {
    const existing = await tx.mappingSynonym.findUnique({ where: { workspaceId_kind_term: { workspaceId, kind: input.kind, term } } });
    const row = existing
      ? await tx.mappingSynonym.update({ where: { id: existing.id }, data: { target: json(input.target), origin: "manual", isActive: true, updatedAt: new Date() } })
      : await tx.mappingSynonym.create({ data: { id: newId(), workspaceId, kind: input.kind, term, target: json(input.target), origin: "manual", createdBy: auth.user.id } });
    await record(tx, auth, { workspaceId, action: existing ? "mapping_synonym.updated" : "mapping_synonym.created", entityType: "mapping_synonym", entityId: row.id, before: existing ? { target: existing.target, origin: existing.origin } : null, after: { kind: row.kind, term, target: input.target }, topic: "mapping_synonym.changed" });
    return { id: row.id, kind: row.kind, term: row.term, target: row.target, origin: row.origin, uses: row.uses, isActive: row.isActive };
  });
}

/** PATCH /mapping-synonyms/:id: switch a word off (or on). */
export async function updateMappingSynonym(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const id = parseId(rawId);
  const input = parseInput(UpdateMappingSynonymInput, raw);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const before = await tx.mappingSynonym.findUnique({ where: { id } });
    if (before === null) throw new DomainError("NOT_FOUND", "Synonym not found");
    const row = await tx.mappingSynonym.update({ where: { id }, data: { isActive: input.isActive, updatedAt: new Date() } });
    await record(tx, auth, { workspaceId: row.workspaceId, action: "mapping_synonym.updated", entityType: "mapping_synonym", entityId: row.id, before: { isActive: before.isActive }, after: { isActive: row.isActive }, topic: "mapping_synonym.changed" });
    return { id: row.id, kind: row.kind, term: row.term, target: row.target, origin: row.origin, uses: row.uses, isActive: row.isActive };
  });
}
