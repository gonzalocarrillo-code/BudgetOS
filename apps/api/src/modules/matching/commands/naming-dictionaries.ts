import {
  BulkDictionaryInput,
  CAMPAIGN_DIMENSION,
  DictionaryEntryInput,
  DomainError,
  FillDictionaryAiInput,
  MAX_AI_CODES,
  MAX_AI_EXAMPLES,
  MAX_AI_VALUES,
  NamingConventionToken,
  UpdateDictionaryEntryInput,
  explainCampaignName,
  newId,
  normalizeToken,
  type DictionaryWriteResponse,
  type FillDictionaryAiResponse,
} from "@budget/domain";
import { fillNamingDictionary, openAiClient } from "@budget/ai";
import {
  audit,
  campaignNames,
  campaignSpend,
  deleteDictionaryEntry,
  liveDictionaryEntry,
  migrateConventionAliases,
  namingResolver,
  outbox,
  resetDictionaryToBuiltin,
  withTenant,
  writeDictionaryEntries,
  type EntryWrite,
  type Tx,
} from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseId, parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { dictionaryDimension, entryView } from "../queries/naming-dictionaries.js";
import { MAX_CAMPAIGNS, REMATCH_TIMEOUT_MS, createDictionaryValues, currentConvention, rematchCampaigns, result } from "./naming-conventions.js";

/**
 * EX-7 (ADR-0093): writes to a workspace's naming dictionaries (source.manage, like the convention:
 * they decide where spend lands). Every write first copies the live conventions' EX-6 aliases into
 * the dictionaries, then — when the newest convention reads this granularity — creates the registry
 * values the campaigns now need and re-matches the campaign facts, in the same transaction. One
 * audit_event and one outbox row: `facts.loaded` after a re-match, else `source.changed`.
 */

interface Change {
  action: string;
  entityId: string;
  written: number;
  skipped: number;
  removed: number;
  before?: unknown;
  after: Record<string, unknown>;
}

const toWrite = (e: DictionaryEntryInput): EntryWrite => ({ code: e.code, value: e.value ?? e.code, label: e.meaning, notes: e.notes ?? null });

async function dictionaryWrite(prisma: PrismaClient, auth: AuthContext, key: string, change: (tx: Tx, dimension: string) => Promise<Change>): Promise<DictionaryWriteResponse> {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(
    prisma,
    auth.ctx,
    async (tx) => {
      const dim = await dictionaryDimension(tx, auth.user.orgId, workspaceId, key);
      const migratedAliases = await migrateConventionAliases(tx, workspaceId, auth.user.id, newId);
      const c = await change(tx, dim.key);
      const conv = await currentConvention(tx, workspaceId);
      const tokens = conv ? NamingConventionToken.array().parse(conv.tokens) : [];
      let createdValues: DictionaryWriteResponse["createdValues"] = [];
      let rematch: DictionaryWriteResponse["rematch"] = null;
      if (conv && tokens.some((t) => t.dimension === dim.key)) {
        createdValues = await createDictionaryValues(tx, workspaceId, { delimiter: conv.delimiter, tokens });
        const pass = await rematchCampaigns(tx, workspaceId);
        rematch = result(pass);
        await outbox(tx, { workspaceId, topic: "facts.loaded", payload: { envelopeIds: pass.envelopeIds, dimension: dim.key, action: c.action } });
      } else await outbox(tx, { workspaceId, topic: "source.changed", payload: { dimension: dim.key, action: c.action } });
      await audit(tx, {
        workspaceId,
        actorId: auth.user.id,
        actorType: auth.ctx.actorType,
        action: c.action,
        entityType: "naming_dictionary",
        entityId: c.entityId,
        before: c.before ?? null,
        after: { dimension: dim.key, ...c.after, migratedAliases: migratedAliases.length, createdValues, rematch },
        requestId: auth.ctx.requestId,
      });
      return { dimension: dim.key, written: c.written, skipped: c.skipped, removed: c.removed, createdValues, rematch };
    },
    { timeoutMs: REMATCH_TIMEOUT_MS },
  );
}

/** POST /workspaces/:ws/naming-dictionaries/:dimension/entries: one entry ("Define" an unresolved code, or add). An existing code is replaced. */
export async function addDictionaryEntry(prisma: PrismaClient, auth: AuthContext, key: string, raw: unknown): Promise<DictionaryWriteResponse> {
  const input = parseInput(DictionaryEntryInput, raw);
  return dictionaryWrite(prisma, auth, key, async (tx, dimension) => {
    const res = await writeDictionaryEntries(tx, requireWorkspace(auth.ctx.workspaceId), dimension, [toWrite(input)], "user", auth.user.id, "replace", newId);
    const row = res.written[0];
    if (!row) throw new DomainError("CONFLICT", "The entry was not written");
    return { action: "naming_dictionary.entry_added", entityId: row.id, written: 1, skipped: 0, removed: res.replaced.length, before: res.replaced.map(entryView), after: entryView(row) };
  });
}

function assertEditable(source: string): void {
  if (source === "sync") throw new DomainError("LOCKED", "This entry is synced from an external source: edit it there");
}

/** PATCH …/entries/:id: an edit is a new row (the old one soft-deleted). Synced entries are read-only. */
export async function updateDictionaryEntry(prisma: PrismaClient, auth: AuthContext, key: string, rawId: string, raw: unknown): Promise<DictionaryWriteResponse> {
  const id = parseId(rawId);
  const input = parseInput(UpdateDictionaryEntryInput, raw);
  return dictionaryWrite(prisma, auth, key, async (tx, dimension) => {
    const workspaceId = requireWorkspace(auth.ctx.workspaceId);
    const old = await liveDictionaryEntry(tx, workspaceId, dimension, id);
    assertEditable(old.source);
    const next: EntryWrite = { code: input.code ?? old.code, value: input.value ?? old.value, label: input.meaning ?? old.label, notes: input.notes === undefined ? old.notes : input.notes };
    // Renaming the code: the old code goes away; the new one replaces whatever had it.
    if (normalizeToken(next.code) !== old.codeNorm) await deleteDictionaryEntry(tx, old.id, auth.user.id);
    // A person's edit makes the entry theirs (a built-in or AI entry included).
    const res = await writeDictionaryEntries(tx, workspaceId, dimension, [next], "user", auth.user.id, "replace", newId);
    const row = res.written[0];
    if (!row) throw new DomainError("CONFLICT", "The entry was not written");
    return { action: "naming_dictionary.entry_updated", entityId: row.id, written: 1, skipped: 0, removed: 1, before: entryView(old), after: entryView(row) };
  });
}

/** DELETE …/entries/:id: soft delete. A deleted built-in entry stays deleted (the seed is copied once). */
export async function removeDictionaryEntry(prisma: PrismaClient, auth: AuthContext, key: string, rawId: string): Promise<DictionaryWriteResponse> {
  const id = parseId(rawId);
  return dictionaryWrite(prisma, auth, key, async (tx, dimension) => {
    const old = await liveDictionaryEntry(tx, requireWorkspace(auth.ctx.workspaceId), dimension, id);
    assertEditable(old.source);
    await deleteDictionaryEntry(tx, old.id, auth.user.id);
    return { action: "naming_dictionary.entry_deleted", entityId: old.id, written: 0, skipped: 0, removed: 1, before: entryView(old), after: { deleted: true } };
  });
}

/** POST …/bulk: a paste, a CSV import, or accepted AI proposals (`source: ai`). One audit row for the lot. */
export async function bulkDictionaryEntries(prisma: PrismaClient, auth: AuthContext, key: string, raw: unknown): Promise<DictionaryWriteResponse> {
  const input = parseInput(BulkDictionaryInput, raw);
  return dictionaryWrite(prisma, auth, key, async (tx, dimension) => {
    const workspaceId = requireWorkspace(auth.ctx.workspaceId);
    const res = await writeDictionaryEntries(tx, workspaceId, dimension, input.entries.map(toWrite), input.source, auth.user.id, input.onConflict, newId);
    const dict = await tx.namingDictionary.findUniqueOrThrow({ where: { workspaceId_dimensionKey: { workspaceId, dimensionKey: dimension } } });
    return {
      action: "naming_dictionary.bulk_written",
      entityId: dict.id,
      written: res.written.length,
      skipped: res.skipped,
      removed: res.replaced.length,
      after: { source: input.source, onConflict: input.onConflict, written: res.written.length, skipped: res.skipped, replaced: res.replaced.length, codes: res.written.slice(0, 200).map((r) => r.code) },
    };
  });
}

/** POST …/reset: "Reset to built-in" — your, AI and built-in entries removed (soft), the built-in seed copied again. Synced entries stay. */
export async function resetDictionary(prisma: PrismaClient, auth: AuthContext, key: string): Promise<DictionaryWriteResponse> {
  return dictionaryWrite(prisma, auth, key, async (tx, dimension) => {
    const workspaceId = requireWorkspace(auth.ctx.workspaceId);
    const res = await resetDictionaryToBuiltin(tx, workspaceId, dimension, auth.user.id, newId);
    const dict = await tx.namingDictionary.findUniqueOrThrow({ where: { workspaceId_dimensionKey: { workspaceId, dimensionKey: dimension } } });
    return { action: "naming_dictionary.reset", entityId: dict.id, written: res.written, skipped: 0, removed: res.removed, after: { removed: res.removed, written: res.written } };
  });
}

/**
 * POST …/ai-fill: "Fill dictionary with AI" — support only. 503 before anything is read when OpenAI
 * is not configured. Sends the position's unresolved codes (largest spend first), a few example
 * names that carry them, the granularity's name and its registry values (codes + labels); never
 * amounts or ids. Nothing is written: the user accepts rows, which `bulk` writes with source `ai`.
 * Audited (who, how many codes, model; no codes or prompt) with one `source.changed` outbox row.
 */
export async function fillDictionaryWithAi(prisma: PrismaClient, auth: AuthContext, key: string, raw: unknown): Promise<FillDictionaryAiResponse> {
  const input = parseInput(FillDictionaryAiInput, raw ?? {});
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const client = openAiClient(); // 503 before any name is read
  const ask = await withTenant(prisma, auth.ctx, async (tx) => {
    const dim = await dictionaryDimension(tx, auth.user.orgId, workspaceId, key);
    const spend = await campaignSpend(tx, workspaceId, MAX_CAMPAIGNS);
    const labels = await campaignNames(tx, workspaceId, spend.map((c) => c.campaign), CAMPAIGN_DIMENSION);
    const names = spend.map((c) => labels.get(c.campaign) ?? c.campaign);
    let codes: string[];
    if (input.codes) codes = input.codes;
    else {
      const conv = await currentConvention(tx, workspaceId);
      const tokens = conv ? NamingConventionToken.array().parse(conv.tokens) : [];
      const at = (input.position ?? 0) - 1;
      if (!conv || tokens[at]?.dimension !== dim.key) throw new DomainError("VALIDATION", "That position of the naming convention is not this granularity", { position: input.position, dimension: dim.key });
      const resolve = await namingResolver(tx, workspaceId, [...new Set(tokens.flatMap((t) => (t.dimension ? [t.dimension] : [])))]);
      const seen = new Map<string, string>();
      for (const n of names) {
        const part = explainCampaignName({ delimiter: conv.delimiter, tokens }, n, resolve).parts[at];
        if (part && part.code === null && part.raw !== "" && !seen.has(normalizeToken(part.raw))) seen.set(normalizeToken(part.raw), part.raw);
      }
      codes = [...seen.values()];
    }
    codes = codes.slice(0, MAX_AI_CODES);
    const wanted = new Set(codes.map(normalizeToken));
    const examples = names.filter((n) => n.split(/[^A-Za-z0-9]+/).some((p) => wanted.has(normalizeToken(p)))).slice(0, MAX_AI_EXAMPLES);
    const dims = await tx.dimension.findMany({ where: { orgId: auth.user.orgId, key: dim.key, OR: [{ workspaceId: null }, { workspaceId }] }, select: { id: true } });
    const values = await tx.dimensionValue.findMany({ where: { dimensionId: { in: dims.map((d) => d.id) }, mergedIntoId: null }, select: { code: true, label: true }, orderBy: { code: "asc" }, take: MAX_AI_VALUES });
    return { dim, codes, examples, values };
  });
  if (ask.codes.length === 0) throw new DomainError("VALIDATION", "Nothing to fill: every code at this position already reads", { dimension: ask.dim.key });
  // No transaction is held over the network call.
  const res = await fillNamingDictionary({ granularity: ask.dim.label, codes: ask.codes, examples: ask.examples, values: ask.values }, client);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const dict = await tx.namingDictionary.findUnique({ where: { workspaceId_dimensionKey: { workspaceId, dimensionKey: ask.dim.key } } });
    await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "naming_dictionary.ai_suggested", entityType: "naming_dictionary", entityId: dict?.id ?? newId(), after: { dimension: ask.dim.key, codes: res.codes, examples: res.examples, proposals: res.proposals.length, model: res.model, applied: false }, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId, topic: "source.changed", payload: { action: "naming_dictionary.ai_suggested", dimension: ask.dim.key } });
    return { dimension: ask.dim.key, proposals: res.proposals, model: res.model, codes: res.codes, examples: res.examples, applied: false as const };
  });
}
