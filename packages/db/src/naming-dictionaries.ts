import { DomainError, NamingConventionToken, SEEDABLE_KINDS, builtinDictionaryRows, dictionaryKindFor, normalizeToken, type DictionaryEntrySource, type DictionaryRows } from "@budget/domain";
import type { NamingDictionaryEntry } from "@prisma/client";
import type { Tx } from "./sql.js";

/**
 * EX-7 (ADR-0093): campaign-naming dictionaries as rows, per workspace and granularity key. The
 * built-in lists (@budget/domain naming-dictionaries.ts) are the seed, copied once; entries are
 * soft-deleted, never hard-deleted, and an edit is a new row. One live row per normalized code.
 */

export interface EntryWrite {
  code: string;
  value: string;
  label: string;
  notes?: string | null | undefined;
}

const isSeedable = (kind: string | null): boolean => kind !== null && (SEEDABLE_KINDS as readonly string[]).includes(kind);

function norm(code: string): string {
  const n = normalizeToken(code);
  if (n === "") throw new DomainError("VALIDATION", "A code needs at least one letter or digit", { code });
  return n.slice(0, 200);
}

/** The workspace dictionaries of these granularity keys, as the resolver reads them (keys without rows are left out). */
export async function loadNamingDictionaries(tx: Tx, workspaceId: string, keys: string[]): Promise<Record<string, DictionaryRows>> {
  if (keys.length === 0) return {};
  const [dicts, entries] = await Promise.all([
    tx.namingDictionary.findMany({ where: { workspaceId, dimensionKey: { in: keys } }, select: { dimensionKey: true, seededAt: true } }),
    tx.namingDictionaryEntry.findMany({ where: { workspaceId, dimensionKey: { in: keys }, deletedAt: null }, select: { dimensionKey: true, code: true, value: true, label: true, source: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
  ]);
  const out: Record<string, { seeded: boolean; entries: Array<DictionaryRows["entries"][number]> }> = {};
  for (const d of dicts) out[d.dimensionKey] = { seeded: d.seededAt !== null, entries: [] };
  for (const e of entries) (out[e.dimensionKey] ??= { seeded: false, entries: [] }).entries.push({ code: e.code, value: e.value, label: e.label, source: e.source as DictionaryEntrySource });
  return out;
}

/** The dictionary row of a granularity (created when missing). */
async function dictionaryRow(tx: Tx, workspaceId: string, key: string, actorId: string, newId: () => string) {
  const kind = dictionaryKindFor(key);
  return tx.namingDictionary.upsert({
    where: { workspaceId_dimensionKey: { workspaceId, dimensionKey: key } },
    create: { id: newId(), workspaceId, dimensionKey: key, builtinKind: kind, createdBy: actorId },
    update: {},
  });
}

async function insertBuiltin(tx: Tx, workspaceId: string, key: string, kind: string, actorId: string, newId: () => string): Promise<number> {
  const rows = builtinDictionaryRows(kind as Parameters<typeof builtinDictionaryRows>[0]);
  const res = await tx.namingDictionaryEntry.createMany({
    data: rows.map((r) => ({ id: newId(), workspaceId, dimensionKey: key, code: r.code, codeNorm: norm(r.code), value: r.value, label: r.label, source: "builtin", createdBy: actorId })),
    // A code the workspace already has (yours, AI, synced) is kept: the partial unique index refuses the seed row.
    skipDuplicates: true,
  });
  return res.count;
}

/**
 * The first time a granularity is used for naming: its built-in entries (if its kind has a list)
 * are copied into the workspace's dictionary. Once only; returns the rows copied (0 afterwards).
 */
export async function ensureDictionarySeeded(tx: Tx, workspaceId: string, key: string, actorId: string, newId: () => string): Promise<number> {
  const dict = await dictionaryRow(tx, workspaceId, key, actorId, newId);
  if (dict.seededAt !== null || !isSeedable(dict.builtinKind)) return 0;
  // Serializes two first uses of the same dictionary: only one copies.
  const claimed = await tx.namingDictionary.updateMany({ where: { id: dict.id, seededAt: null }, data: { seededAt: new Date(), updatedAt: new Date() } });
  if (claimed.count === 0) return 0;
  return insertBuiltin(tx, workspaceId, key, dict.builtinKind as string, actorId, newId);
}

/** "Reset to built-in": every live entry except synced ones is removed (soft) and the built-in seed copied again. */
export async function resetDictionaryToBuiltin(tx: Tx, workspaceId: string, key: string, actorId: string, newId: () => string): Promise<{ removed: number; written: number }> {
  const dict = await dictionaryRow(tx, workspaceId, key, actorId, newId);
  if (!isSeedable(dict.builtinKind)) throw new DomainError("VALIDATION", "This granularity has no built-in dictionary", { dimension: key });
  const removed = await tx.namingDictionaryEntry.updateMany({ where: { workspaceId, dimensionKey: key, deletedAt: null, source: { not: "sync" } }, data: { deletedAt: new Date(), deletedBy: actorId } });
  await tx.namingDictionary.update({ where: { id: dict.id }, data: { seededAt: new Date(), updatedAt: new Date() } });
  const written = await insertBuiltin(tx, workspaceId, key, dict.builtinKind as string, actorId, newId);
  return { removed: removed.count, written };
}

/**
 * EX-6's per-position aliases (naming_convention.tokens) copied into the dictionaries as your
 * entries, where the dictionary has no live entry for that code yet. Idempotent; the aliases stay
 * in the convention and are still read (they agree). Returns the entries written.
 */
export async function migrateConventionAliases(tx: Tx, workspaceId: string, actorId: string, newId: () => string): Promise<Array<{ dimension: string; code: string; value: string }>> {
  const live = await tx.namingConvention.findMany({ where: { workspaceId, deletedAt: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const wanted = new Map<string, { dimension: string; code: string; value: string }>();
  for (const c of live) {
    for (const t of NamingConventionToken.array().parse(c.tokens)) {
      if (t.dimension === null) continue;
      for (const [code, value] of Object.entries(t.aliases)) {
        const k = `${t.dimension}\u0000${normalizeToken(code)}`;
        if (normalizeToken(code) !== "" && !wanted.has(k)) wanted.set(k, { dimension: t.dimension, code, value });
      }
    }
  }
  if (wanted.size === 0) return [];
  const existing = await tx.namingDictionaryEntry.findMany({ where: { workspaceId, deletedAt: null, dimensionKey: { in: [...new Set([...wanted.values()].map((w) => w.dimension))] } }, select: { dimensionKey: true, codeNorm: true } });
  const have = new Set(existing.map((e) => `${e.dimensionKey}\u0000${e.codeNorm}`));
  const todo = [...wanted.entries()].filter(([k]) => !have.has(k)).map(([, w]) => w);
  for (const d of new Set(todo.map((w) => w.dimension))) await dictionaryRow(tx, workspaceId, d, actorId, newId);
  if (todo.length) await tx.namingDictionaryEntry.createMany({ data: todo.map((w) => ({ id: newId(), workspaceId, dimensionKey: w.dimension, code: w.code, codeNorm: norm(w.code), value: w.value, label: w.value, notes: "EX-6 alias", source: "user", createdBy: actorId })), skipDuplicates: true });
  return todo;
}

/** EX-6 aliases of the live conventions not yet in a dictionary: listed (read-only) until the next write copies them. */
export async function pendingConventionAliases(tx: Tx, workspaceId: string, key: string): Promise<Array<{ code: string; value: string }>> {
  const live = await tx.namingConvention.findMany({ where: { workspaceId, deletedAt: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const out = new Map<string, { code: string; value: string }>();
  for (const c of live) for (const t of NamingConventionToken.array().parse(c.tokens)) if (t.dimension === key) for (const [code, value] of Object.entries(t.aliases)) if (!out.has(normalizeToken(code))) out.set(normalizeToken(code), { code, value });
  if (out.size === 0) return [];
  const have = new Set((await tx.namingDictionaryEntry.findMany({ where: { workspaceId, dimensionKey: key, deletedAt: null, codeNorm: { in: [...out.keys()] } }, select: { codeNorm: true } })).map((e) => e.codeNorm));
  return [...out.entries()].filter(([k]) => !have.has(k)).map(([, v]) => v);
}

/** Live entries of a dictionary whose code, meaning or value contains `q` (any case), by code; and how many match. */
export async function listDictionaryEntries(tx: Tx, workspaceId: string, key: string, q: string | undefined, limit: number): Promise<{ total: number; rows: NamingDictionaryEntry[] }> {
  const text = q?.trim() ?? "";
  const where = {
    workspaceId,
    dimensionKey: key,
    deletedAt: null,
    ...(text === "" ? {} : { OR: [{ code: { contains: text, mode: "insensitive" as const } }, { label: { contains: text, mode: "insensitive" as const } }, { value: { contains: text, mode: "insensitive" as const } }] }),
  };
  const [total, rows] = await Promise.all([tx.namingDictionaryEntry.count({ where }), tx.namingDictionaryEntry.findMany({ where, orderBy: [{ codeNorm: "asc" }, { id: "asc" }], take: limit })]);
  return { total, rows };
}

/** How many live entries each of these dictionaries has. */
export async function dictionaryEntryCounts(tx: Tx, workspaceId: string): Promise<Map<string, number>> {
  const rows = await tx.namingDictionaryEntry.groupBy({ by: ["dimensionKey"], where: { workspaceId, deletedAt: null }, _count: { _all: true } });
  return new Map(rows.map((r) => [r.dimensionKey, r._count._all]));
}

export interface WriteResult {
  written: NamingDictionaryEntry[];
  skipped: number;
  /** The live rows the write replaced (soft-deleted). */
  replaced: NamingDictionaryEntry[];
}

/**
 * Entries written into a dictionary (one add, a paste, a CSV import, accepted AI proposals). A
 * code the dictionary already has is replaced (the old row soft-deleted, a new one inserted) or,
 * with `skip`, left alone. Codes repeated in one write: the last one wins.
 */
export async function writeDictionaryEntries(tx: Tx, workspaceId: string, key: string, entries: EntryWrite[], source: Exclude<DictionaryEntrySource, "builtin" | "sync">, actorId: string, onConflict: "replace" | "skip", newId: () => string): Promise<WriteResult> {
  await dictionaryRow(tx, workspaceId, key, actorId, newId);
  const byNorm = new Map<string, EntryWrite>();
  for (const e of entries) byNorm.set(norm(e.code), e);
  const live = await tx.namingDictionaryEntry.findMany({ where: { workspaceId, dimensionKey: key, deletedAt: null, codeNorm: { in: [...byNorm.keys()] } } });
  const liveBy = new Map(live.map((r) => [r.codeNorm, r]));
  const replaced: NamingDictionaryEntry[] = [];
  let skipped = 0;
  const data: Array<{ id: string; workspaceId: string; dimensionKey: string; code: string; codeNorm: string; value: string; label: string; notes: string | null; source: string; createdBy: string }> = [];
  for (const [k, e] of byNorm) {
    const old = liveBy.get(k);
    if (old && onConflict === "skip") {
      skipped++;
      continue;
    }
    if (old) replaced.push(old);
    data.push({ id: newId(), workspaceId, dimensionKey: key, code: e.code, codeNorm: k, value: e.value, label: e.label, notes: e.notes ?? null, source, createdBy: actorId });
  }
  if (replaced.length) await tx.namingDictionaryEntry.updateMany({ where: { id: { in: replaced.map((r) => r.id) } }, data: { deletedAt: new Date(), deletedBy: actorId } });
  if (data.length) await tx.namingDictionaryEntry.createMany({ data });
  const written = data.length ? await tx.namingDictionaryEntry.findMany({ where: { id: { in: data.map((d) => d.id) } }, orderBy: { codeNorm: "asc" } }) : [];
  return { written, skipped, replaced };
}

/** One live entry of this workspace's dictionary of `key`, or NOT_FOUND. */
export async function liveDictionaryEntry(tx: Tx, workspaceId: string, key: string, id: string): Promise<NamingDictionaryEntry> {
  const row = await tx.namingDictionaryEntry.findUnique({ where: { id } });
  if (row === null || row.workspaceId !== workspaceId || row.dimensionKey !== key || row.deletedAt !== null) throw new DomainError("NOT_FOUND", "Dictionary entry not found");
  return row;
}

/** Soft-delete one entry. */
export async function deleteDictionaryEntry(tx: Tx, id: string, actorId: string): Promise<void> {
  await tx.namingDictionaryEntry.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: actorId } });
}
