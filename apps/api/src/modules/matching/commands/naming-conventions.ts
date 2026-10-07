import {
  AddNamingAliasInput,
  CAMPAIGN_DIMENSION,
  CreateNamingConventionInput,
  DomainError,
  NamingConventionToken,
  explainCampaignName,
  newId,
  normalizeToken,
  type NamingConventionSaveResponse,
  type NamingConventionWriteResponse,
  type RematchResult,
} from "@budget/domain";
import { audit, campaignNames, campaignSpend, closedPeriods, ensureDictionaryValues, matchFacts, namingResolver, outbox, withTenant, type DictionaryValue, type MatchPass, type Tx } from "@budget/db";
import type { NamingConvention, Prisma, PrismaClient } from "@prisma/client";
import { parseId, parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { conventionView } from "../queries/match-rules.js";

/**
 * EX-5 (ADR-0090): naming conventions — how campaign names are built — are registry rows a data
 * admin writes (source.manage, like the unmatched queue: they decide where spend lands for every
 * budget, not one). A write re-matches, in the same transaction, every live unpinned fact that has
 * a campaign (closed periods are left alone). One audit_event and one `facts.loaded` outbox row.
 */

const REMATCH_TIMEOUT_MS = 120_000;
/** The facts a convention can change: those with a campaign. */
const HAS_CAMPAIGN = { logic: "and", children: [{ field: { kind: "dimension", key: CAMPAIGN_DIMENSION }, op: "not_empty" }] };

const result = (p: MatchPass): RematchResult => ({ spend: p.spend, kpi: p.kpi, projection: p.projection, envelopeIds: p.envelopeIds });

async function rematchCampaigns(tx: Tx, workspaceId: string): Promise<MatchPass> {
  const keep = (await closedPeriods(tx, workspaceId)).map((c) => ({ start: c.start, end: c.end }));
  return matchFacts(tx, workspaceId, { predicate: HAS_CAMPAIGN, keep });
}

/** POST /workspaces/:ws/naming-conventions. */
export async function createNamingConvention(prisma: PrismaClient, auth: AuthContext, raw: unknown): Promise<NamingConventionWriteResponse> {
  const input = parseInput(CreateNamingConventionInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(
    prisma,
    auth.ctx,
    async (tx) => {
      const keys = [...new Set(input.tokens.flatMap((t) => (t.dimension === null ? [] : [t.dimension])))];
      const found = await tx.dimension.findMany({ where: { orgId: auth.user.orgId, isActive: true, key: { in: keys }, OR: [{ workspaceId: null }, { workspaceId }] }, select: { key: true } });
      const missing = keys.filter((k) => !found.some((d) => d.key === k));
      if (missing.length) throw new DomainError("VALIDATION", "The convention names dimensions the registry does not have", { missing });
      const tokens = input.tokens as unknown as Prisma.InputJsonValue;
      const same = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text FROM naming_convention WHERE workspace_id = ${workspaceId}::uuid AND deleted_at IS NULL AND delimiter = ${input.delimiter} AND tokens = ${JSON.stringify(input.tokens)}::jsonb`;
      if (same[0]) throw new DomainError("CONFLICT", "This naming convention already exists", { namingConventionId: same[0].id });
      const row = await tx.namingConvention.create({ data: { id: newId(), workspaceId, delimiter: input.delimiter, tokens, createdBy: auth.user.id } });
      const pass = await rematchCampaigns(tx, workspaceId);
      const view = conventionView(row);
      await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "naming_convention.created", entityType: "naming_convention", entityId: row.id, after: { ...view, rematch: result(pass) }, requestId: auth.ctx.requestId });
      await outbox(tx, { workspaceId, topic: "facts.loaded", payload: { envelopeIds: pass.envelopeIds, namingConventionId: row.id, action: "naming_convention.created" } });
      return { convention: view, rematch: result(pass) };
    },
    { timeoutMs: REMATCH_TIMEOUT_MS },
  );
}

/** DELETE /naming-conventions/:id: soft delete, then the campaign facts are matched again without it. */
export async function deleteNamingConvention(prisma: PrismaClient, auth: AuthContext, rawId: string): Promise<NamingConventionWriteResponse> {
  const id = parseId(rawId);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(
    prisma,
    auth.ctx,
    async (tx) => {
      const current = await tx.namingConvention.findUnique({ where: { id } });
      if (current === null || current.workspaceId !== workspaceId || current.deletedAt !== null) throw new DomainError("NOT_FOUND", "Naming convention not found");
      const row = await tx.namingConvention.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: auth.user.id } });
      const pass = await rematchCampaigns(tx, workspaceId);
      const view = conventionView(row);
      await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "naming_convention.deleted", entityType: "naming_convention", entityId: id, before: conventionView(current), after: { deletedAt: row.deletedAt?.toISOString() ?? null, rematch: result(pass) }, requestId: auth.ctx.requestId });
      await outbox(tx, { workspaceId, topic: "facts.loaded", payload: { envelopeIds: pass.envelopeIds, namingConventionId: id, action: "naming_convention.deleted" } });
      return { convention: view, rematch: result(pass) };
    },
    { timeoutMs: REMATCH_TIMEOUT_MS },
  );
}

// ---- EX-6 (ADR-0091): the workspace's convention, edited in Registry ------------------------------

/** Every live campaign is read when values are created or tokens priced; more than this is cut. */
export const MAX_CAMPAIGNS = 5000;

async function assertDimensions(tx: Tx, orgId: string, workspaceId: string, keys: string[]): Promise<void> {
  const found = await tx.dimension.findMany({ where: { orgId, isActive: true, key: { in: keys }, OR: [{ workspaceId: null }, { workspaceId }] }, select: { key: true } });
  const missing = keys.filter((k) => !found.some((d) => d.key === k));
  if (missing.length) throw new DomainError("VALIDATION", "The convention names dimensions the registry does not have", { missing });
}

/**
 * The registry values a convention needs that only a dictionary knows (UK → GB when the registry
 * has no GB): read every live campaign name with it and create those values (rows, not columns).
 */
async function createDictionaryValues(tx: Tx, workspaceId: string, convention: { delimiter: string; tokens: NamingConventionToken[] }): Promise<DictionaryValue[]> {
  const keys = [...new Set(convention.tokens.flatMap((t) => (t.dimension === null ? [] : [t.dimension])))];
  const resolve = await namingResolver(tx, workspaceId, keys);
  const codes = (await campaignSpend(tx, workspaceId, MAX_CAMPAIGNS)).map((c) => c.campaign);
  const names = await campaignNames(tx, workspaceId, codes, CAMPAIGN_DIMENSION);
  const wanted: DictionaryValue[] = [];
  for (const code of codes) {
    for (const part of explainCampaignName(convention, names.get(code) ?? code, resolve).parts) {
      if (part.dimension === null || part.code === null) continue;
      const token = convention.tokens[part.position - 1];
      const k = normalizeToken(part.raw);
      const alias = Object.entries(token?.aliases ?? {}).find(([a]) => normalizeToken(a) === k);
      const hit = resolve(part.dimension, alias ? alias[1] : part.raw);
      if (hit && !hit.known) wanted.push({ dimension: part.dimension, code: hit.code, label: hit.label ?? hit.code });
    }
  }
  return ensureDictionaryValues(tx, workspaceId, wanted, newId);
}

/** The newest live convention: the one Registry edits (EX-5 allowed several; matching still tries the older ones after it). */
async function currentConvention(tx: Tx, workspaceId: string): Promise<NamingConvention | null> {
  return tx.namingConvention.findFirst({ where: { workspaceId, deletedAt: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
}

/**
 * PUT /workspaces/:ws/naming-convention: the workspace's convention (separator, the position of each
 * granularity, its aliases). Never updated in place: the live ones are soft-deleted and a new row
 * is written. Values only a dictionary knows are created; every campaign fact is matched again.
 * One audit_event (`naming_convention.saved`) + one `facts.loaded` outbox row.
 */
export async function saveNamingConvention(prisma: PrismaClient, auth: AuthContext, raw: unknown): Promise<NamingConventionSaveResponse> {
  const input = parseInput(CreateNamingConventionInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(
    prisma,
    auth.ctx,
    async (tx) => {
      await assertDimensions(tx, auth.user.orgId, workspaceId, [...new Set(input.tokens.flatMap((t) => (t.dimension === null ? [] : [t.dimension])))]);
      const live = await tx.namingConvention.findMany({ where: { workspaceId, deletedAt: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
      if (live.length > 0) await tx.namingConvention.updateMany({ where: { id: { in: live.map((c) => c.id) } }, data: { deletedAt: new Date(), deletedBy: auth.user.id } });
      const row = await tx.namingConvention.create({ data: { id: newId(), workspaceId, delimiter: input.delimiter, tokens: input.tokens as unknown as Prisma.InputJsonValue, createdBy: auth.user.id } });
      const createdValues = await createDictionaryValues(tx, workspaceId, input);
      const pass = await rematchCampaigns(tx, workspaceId);
      const view = conventionView(row);
      await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "naming_convention.saved", entityType: "naming_convention", entityId: row.id, before: live.map(conventionView), after: { ...view, createdValues, rematch: result(pass) }, requestId: auth.ctx.requestId });
      await outbox(tx, { workspaceId, topic: "facts.loaded", payload: { envelopeIds: pass.envelopeIds, namingConventionId: row.id, action: "naming_convention.saved" } });
      return { convention: view, rematch: result(pass), createdValues };
    },
    { timeoutMs: REMATCH_TIMEOUT_MS },
  );
}

/**
 * POST /workspaces/:ws/naming-convention/aliases: "map to…" for an unresolved token. The token of
 * the position that names `dimension` reads as `value` (which must resolve: a registry value or a
 * dictionary entry, landing on its code). A new version of the convention; one audit_event
 * (`naming_convention.alias_added`) + one `facts.loaded` outbox row.
 */
export async function addNamingAlias(prisma: PrismaClient, auth: AuthContext, raw: unknown): Promise<NamingConventionSaveResponse> {
  const input = parseInput(AddNamingAliasInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(
    prisma,
    auth.ctx,
    async (tx) => {
      const current = await currentConvention(tx, workspaceId);
      if (current === null) throw new DomainError("NOT_FOUND", "The workspace has no naming convention");
      const tokens = NamingConventionToken.array().parse(current.tokens);
      const at = tokens.findIndex((t) => t.dimension === input.dimension);
      if (at < 0) throw new DomainError("VALIDATION", "No position of the naming convention is this dimension", { dimension: input.dimension });
      const hit = (await namingResolver(tx, workspaceId, [input.dimension]))(input.dimension, input.value);
      if (hit === null) throw new DomainError("VALIDATION", "The value is not a value of this dimension", { dimension: input.dimension, value: input.value });
      const k = normalizeToken(input.token);
      const next = tokens.map((t, i) => (i !== at ? t : { ...t, aliases: { ...Object.fromEntries(Object.entries(t.aliases).filter(([a]) => normalizeToken(a) !== k)), [input.token]: hit.code } }));
      await tx.namingConvention.update({ where: { id: current.id }, data: { deletedAt: new Date(), deletedBy: auth.user.id } });
      const row = await tx.namingConvention.create({ data: { id: newId(), workspaceId, delimiter: current.delimiter, tokens: next as unknown as Prisma.InputJsonValue, createdBy: auth.user.id } });
      const createdValues = await createDictionaryValues(tx, workspaceId, { delimiter: row.delimiter, tokens: next });
      const pass = await rematchCampaigns(tx, workspaceId);
      const view = conventionView(row);
      const alias = { dimension: input.dimension, token: input.token, value: hit.code };
      await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "naming_convention.alias_added", entityType: "naming_convention", entityId: row.id, before: conventionView(current), after: { ...view, alias, createdValues, rematch: result(pass) }, requestId: auth.ctx.requestId });
      await outbox(tx, { workspaceId, topic: "facts.loaded", payload: { envelopeIds: pass.envelopeIds, namingConventionId: row.id, action: "naming_convention.alias_added" } });
      return { convention: view, rematch: result(pass), createdValues };
    },
    { timeoutMs: REMATCH_TIMEOUT_MS },
  );
}
