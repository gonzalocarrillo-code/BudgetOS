import {
  CAMPAIGN_DIMENSION,
  DictionaryQuery,
  DomainError,
  NamingConventionToken,
  SEEDABLE_KINDS,
  builtinDictionaryRows,
  dictionaryKindFor,
  dictionarySize,
  type DictionaryEntrySource,
  type DictionaryEntryView,
  type DictionaryKind,
  type NamingDictionariesResponse,
  type NamingDictionaryView,
} from "@budget/domain";
import { dictionaryEntryCounts, listDictionaryEntries, pendingConventionAliases, withTenant, type Tx } from "@budget/db";
import type { NamingDictionaryEntry, PrismaClient } from "@prisma/client";
import { parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { aiAvailable, namingDimensions } from "./naming.js";

/** EX-7 (ADR-0093): reads behind Registry › Campaign names › Dictionaries. */

/** The live granularity of this key (org-wide or this workspace's) a dictionary belongs to. Never the campaign itself (EX-9: data-derived). */
export async function dictionaryDimension(tx: Tx, orgId: string, workspaceId: string, key: string): Promise<{ key: string; label: string }> {
  if (key === CAMPAIGN_DIMENSION) throw new DomainError("VALIDATION", "Campaigns are what is parsed: the campaign granularity has no dictionary");
  const dims = await tx.dimension.findMany({ where: { orgId, key, isActive: true, OR: [{ workspaceId: null }, { workspaceId }] }, select: { key: true, label: true, workspaceId: true } });
  const dim = dims.find((d) => d.workspaceId !== null) ?? dims[0];
  if (!dim) throw new DomainError("NOT_FOUND", "Granularity not found", { dimension: key });
  return { key: dim.key, label: dim.label };
}

export const entryView = (r: NamingDictionaryEntry): DictionaryEntryView => ({
  id: r.id,
  code: r.code,
  meaning: r.label,
  value: r.value,
  notes: r.notes,
  source: r.source as DictionaryEntrySource,
  syncSourceId: r.syncSourceId,
  legacy: false,
  createdAt: r.createdAt.toISOString(),
});

const builtinCount = (kind: DictionaryKind | null): number | null => (kind !== null && (SEEDABLE_KINDS as readonly string[]).includes(kind) ? builtinDictionaryRows(kind).length : kind === "quarter" ? dictionarySize(kind) : null);

/** The 1-based position of the newest live convention that reads each granularity. */
async function positions(tx: Tx, workspaceId: string): Promise<Map<string, number>> {
  const c = await tx.namingConvention.findFirst({ where: { workspaceId, deletedAt: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const out = new Map<string, number>();
  if (c) NamingConventionToken.array().parse(c.tokens).forEach((t, i) => t.dimension !== null && out.set(t.dimension, i + 1));
  return out;
}

/** GET /workspaces/:ws/naming-dictionaries: every granularity (except the campaign) with its dictionary's state. */
export async function listNamingDictionaries(prisma: PrismaClient, auth: AuthContext): Promise<NamingDictionariesResponse> {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const [dims, rows, counts, at] = await Promise.all([namingDimensions(tx, auth.user.orgId, workspaceId), tx.namingDictionary.findMany({ where: { workspaceId } }), dictionaryEntryCounts(tx, workspaceId), positions(tx, workspaceId)]);
    const byKey = new Map(rows.map((r) => [r.dimensionKey, r]));
    return {
      dictionaries: dims.map((d) => {
        const kind = dictionaryKindFor(d.key);
        const row = byKey.get(d.key);
        return { dimension: d.key, label: d.label, kind, seeded: row?.seededAt != null, builtinCount: builtinCount(kind), syncSourceId: row?.syncSourceId ?? null, position: at.get(d.key) ?? null, entries: counts.get(d.key) ?? 0 };
      }),
      aiAvailable: aiAvailable(),
    };
  });
}

/** GET /workspaces/:ws/naming-dictionaries/:dimension?q&limit: the entries (EX-6 aliases not yet copied first, read-only). */
export async function getNamingDictionary(prisma: PrismaClient, auth: AuthContext, key: string, raw: unknown): Promise<NamingDictionaryView> {
  const q = parseInput(DictionaryQuery, raw ?? {});
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const dim = await dictionaryDimension(tx, auth.user.orgId, workspaceId, key);
    const kind = dictionaryKindFor(dim.key);
    const [row, list, pending, at] = await Promise.all([
      tx.namingDictionary.findUnique({ where: { workspaceId_dimensionKey: { workspaceId, dimensionKey: dim.key } } }),
      listDictionaryEntries(tx, workspaceId, dim.key, q.q, q.limit ?? 500),
      pendingConventionAliases(tx, workspaceId, dim.key),
      positions(tx, workspaceId),
    ]);
    const text = (q.q ?? "").trim().toLowerCase();
    const legacy = pending
      .filter((a) => text === "" || a.code.toLowerCase().includes(text) || a.value.toLowerCase().includes(text))
      .map((a): DictionaryEntryView => ({ id: null, code: a.code, meaning: a.value, value: a.value, notes: null, source: "user", syncSourceId: null, legacy: true, createdAt: null }));
    return {
      dimension: dim.key,
      label: dim.label,
      kind,
      seeded: row?.seededAt != null,
      builtinCount: builtinCount(kind),
      syncSourceId: row?.syncSourceId ?? null,
      position: at.get(dim.key) ?? null,
      total: list.total + legacy.length,
      entries: [...legacy, ...list.rows.map(entryView)],
    };
  });
}
