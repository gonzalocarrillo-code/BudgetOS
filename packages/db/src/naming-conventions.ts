import { CAMPAIGN_DIMENSION, makeTokenResolver, type RegistryValueRef, type TokenResolver } from "@budget/domain";
import { Decimal } from "decimal.js";
import type { Tx } from "./sql.js";

/**
 * EX-6 (ADR-0091): registry reads and writes behind campaign naming conventions — the resolver
 * (registry values, then the built-in dictionary of the dimension's kind), the live spend per
 * campaign (to rank names and price unresolved tokens) and creating dictionary values on demand.
 */

/** The org-wide and this workspace's dimensions of these keys (a workspace's own wins where both exist). */
async function dimensionsByKey(tx: Tx, workspaceId: string, keys: string[]): Promise<Map<string, Array<{ id: string; workspaceId: string | null }>>> {
  const out = new Map<string, Array<{ id: string; workspaceId: string | null }>>();
  if (keys.length === 0) return out;
  const ws = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { orgId: true } });
  const dims = await tx.dimension.findMany({ where: { orgId: ws.orgId, key: { in: keys }, OR: [{ workspaceId: null }, { workspaceId }] }, select: { id: true, key: true, workspaceId: true } });
  for (const d of dims) out.set(d.key, [...(out.get(d.key) ?? []), { id: d.id, workspaceId: d.workspaceId }].sort((a, b) => Number(b.workspaceId !== null) - Number(a.workspaceId !== null)));
  return out;
}

/**
 * Token → value code for convention parts: a registry value (code, value alias or label; org-wide
 * or this workspace's dimension of that key), else the dimension kind's dictionary (`@budget/domain`
 * makeTokenResolver). Merged values are skipped.
 */
export async function namingResolver(tx: Tx, workspaceId: string, keys: string[]): Promise<TokenResolver> {
  const dims = await dimensionsByKey(tx, workspaceId, keys);
  const keyOf = new Map([...dims].flatMap(([key, list]) => list.map((d) => [d.id, key] as const)));
  const values = keyOf.size === 0 ? [] : await tx.dimensionValue.findMany({ where: { dimensionId: { in: [...keyOf.keys()] }, mergedIntoId: null }, select: { dimensionId: true, code: true, label: true, aliases: true }, orderBy: [{ code: "asc" }] });
  const registry: Record<string, RegistryValueRef[]> = Object.fromEntries(keys.map((k) => [k, []]));
  // A workspace's own dimension first: its values win a shared token.
  const rank = new Map([...dims.values()].flatMap((list) => list.map((d, i) => [d.id, i] as const)));
  for (const v of [...values].sort((a, b) => (rank.get(a.dimensionId) ?? 0) - (rank.get(b.dimensionId) ?? 0))) {
    const key = keyOf.get(v.dimensionId);
    if (key) registry[key]?.push({ code: v.code, label: v.label, aliases: v.aliases });
  }
  return makeTokenResolver(registry);
}

export interface CampaignSpend {
  campaign: string;
  /** Live spend in the reporting currency (Decimal string). */
  amount: string;
}

/** Live spend per campaign value (code), largest first; `limit` campaigns at most. */
export async function campaignSpend(tx: Tx, workspaceId: string, limit: number): Promise<CampaignSpend[]> {
  const rows = await tx.$queryRaw<Array<{ c: string; amount: string }>>`
    SELECT dimension_values ->> ${CAMPAIGN_DIMENSION} AS c, sum(amount_reporting)::text AS amount FROM spend_fact
    WHERE workspace_id = ${workspaceId}::uuid AND superseded_at IS NULL AND dimension_values ? ${CAMPAIGN_DIMENSION}
    GROUP BY 1 ORDER BY sum(amount_reporting) DESC, 1 LIMIT ${limit}`;
  return rows.map((r) => ({ campaign: r.c, amount: new Decimal(r.amount).toFixed(2) }));
}

export interface DictionaryValue {
  dimension: string;
  code: string;
  label: string;
}

/**
 * Registry values created from a dictionary on demand (rows, not columns): each one goes into the
 * workspace's own dimension of that key, else the org-wide one; a code that already exists there
 * is left exactly as it is. Returns the values actually created.
 */
export async function ensureDictionaryValues(tx: Tx, workspaceId: string, values: DictionaryValue[], newId: () => string): Promise<DictionaryValue[]> {
  const dims = await dimensionsByKey(tx, workspaceId, [...new Set(values.map((v) => v.dimension))]);
  const created: DictionaryValue[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const target = dims.get(v.dimension)?.[0];
    const k = `${v.dimension}\u0000${v.code}`;
    if (!target || seen.has(k)) continue;
    seen.add(k);
    const n = await tx.$executeRaw`
      INSERT INTO dimension_value (id, dimension_id, code, label) VALUES (${newId()}::uuid, ${target.id}::uuid, ${v.code}, ${v.label})
      ON CONFLICT (dimension_id, code) DO NOTHING`;
    if (n > 0) created.push(v);
  }
  return created;
}
