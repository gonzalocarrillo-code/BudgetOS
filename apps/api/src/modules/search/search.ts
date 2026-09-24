import { DomainError, can, parseSearch, type ScopeFilter } from "@budget/domain";
import { withTenant } from "@budget/db";
import { SEARCH_TYPES, compileSearch, searchTypes } from "@budget/query-planner";
import type { PrismaClient } from "@prisma/client";
import { requireWorkspace } from "../../common/parse-input.js";
import type { AuthContext } from "../../common/tenant.js";

/** Global search and qualifier suggestions (spec §12.2–12.3, plan §11.3). */

type Hit = { entity_type: string; entity_id: string; title: string; path: string; status: string | null; numeric_facets: unknown; rank: number; type_count: bigint };

/** The caller's scopes for reading envelopes; null when any role reads the whole workspace. */
export function readScopes(auth: AuthContext): ScopeFilter[] | null {
  if (auth.isOrgAdmin) return null;
  const readers = auth.assignments.filter((a) => can([a.role], "envelope.read"));
  if (readers.some((a) => !("children" in a.scope) || a.scope.children.length === 0)) return null;
  return readers.map((a) => a.scope);
}

export function deepLink(workspaceId: string, type: string, id: string, title: string): string {
  const w = `/w/${workspaceId}`;
  switch (type) {
    case "envelope":
      return `${w}/budgets?select=${id}`;
    case "target":
      return `${w}/targets?select=${id}`;
    case "approval_request":
      return `${w}/approvals/${id}`;
    case "alert":
      return `${w}/alerts?select=${id}`;
    case "comment":
      return `${w}/threads?comment=${id}`;
    case "tag":
      return `${w}/budgets?filter=${encodeURIComponent(JSON.stringify({ logic: "and", children: [{ field: { kind: "attr", key: "tag" }, op: "eq", value: title }] }))}`;
    default:
      return `${w}/admin/registry?value=${id}`;
  }
}

/** GET /workspaces/:ws/search?q&types&limit: top hits per type with per-type counts. */
export async function search(prisma: PrismaClient, auth: AuthContext, query: { q?: string | undefined; types?: string | undefined; limit?: string | undefined }) {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const q = (query.q ?? "").slice(0, 500);
  const limit = query.limit === undefined ? 5 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new DomainError("VALIDATION", "limit must be 1..50");
  const parsed = parseSearch(q);
  if (query.types) parsed.types.push(...query.types.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean));
  const c = compileSearch(parsed, { workspaceId, userId: auth.user.id, scopes: readScopes(auth), limitPerType: limit });
  const rows = await withTenant(prisma, auth.ctx, (tx) => tx.$queryRawUnsafe<Hit[]>(c.sql, ...c.values));
  const groups = new Map<string, { type: string; count: number; hits: unknown[] }>();
  for (const r of rows) {
    const g = groups.get(r.entity_type) ?? { type: r.entity_type, count: Number(r.type_count), hits: [] };
    g.hits.push({ id: r.entity_id, title: r.title, path: r.path, status: r.status, facets: r.numeric_facets, deepLink: deepLink(workspaceId, r.entity_type, r.entity_id, r.title) });
    groups.set(r.entity_type, g);
  }
  const order = SEARCH_TYPES as readonly string[];
  return { groups: [...groups.values()].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type)), parsed: { ...parsed, types: c.types } };
}

const FIXED_KEYS: Array<{ key: string; label: string }> = [
  { key: "type", label: "Type" },
  { key: "status", label: "Status" },
  { key: "owner", label: "Owner" },
  { key: "tag", label: "Tag" },
  { key: "period", label: "Period" },
  { key: "budget", label: "Budget" },
  { key: "actual", label: "Actual" },
  { key: "cpa", label: "CPA" },
  { key: "pace", label: "Pace index" },
  { key: "has", label: "Has" },
  { key: "mentions", label: "Mentions" },
  { key: "updated", label: "Updated" },
];
const STATUSES = ["draft", "pending", "approved", "locked", "archived", "open", "acknowledged", "snoozed", "resolved", "rejected", "escalated", "active"];

/**
 * GET /workspaces/:ws/search/suggest?prefix: qualifier keys (the fixed set plus every registry
 * dimension key, read live so a new dimension is a qualifier at once) or, after `key:`, up to ten
 * values for that key.
 */
export async function suggest(prisma: PrismaClient, auth: AuthContext, rawPrefix: string | undefined) {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const prefix = (rawPrefix ?? "").trim().toLowerCase().slice(0, 100);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const dims = await tx.dimension.findMany({ where: { orgId: auth.user.orgId, isActive: true, OR: [{ workspaceId: null }, { workspaceId }] }, select: { id: true, key: true, label: true }, orderBy: [{ sortOrder: "asc" }, { key: "asc" }] });
    const colon = prefix.indexOf(":");
    if (colon === -1) {
      const keys = [...FIXED_KEYS.map((k) => ({ ...k, kind: "fixed" as const })), ...dims.map((d) => ({ key: d.key, label: d.label, kind: "dimension" as const }))];
      return { keys: keys.filter((k) => k.key.startsWith(prefix) || k.label.toLowerCase().startsWith(prefix)).slice(0, 20), values: [] };
    }
    const key = prefix.slice(0, colon);
    const partial = prefix.slice(colon + 1).replace(/^[<>-]/, "");
    const starts = (s: string) => s.toLowerCase().startsWith(partial);
    const values = async (): Promise<Array<{ value: string; label: string }>> => {
      switch (key) {
        case "type":
          return [...SEARCH_TYPES, ...["approval", "value"]].filter(starts).map((v) => ({ value: v, label: searchTypes([v])[0] ?? v }));
        case "status":
          return STATUSES.filter(starts).map((v) => ({ value: v, label: v }));
        case "has":
          return [{ value: "open-thread", label: "Open thread" }].filter((v) => starts(v.value));
        case "owner":
        case "mentions": {
          const users = await tx.user.findMany({ where: { orgId: auth.user.orgId, email: { startsWith: partial, mode: "insensitive" } }, select: { email: true, name: true }, take: 9, orderBy: { email: "asc" } });
          return [{ value: "@me", label: "Me" }, ...users.map((u) => ({ value: u.email, label: u.name }))].filter((v) => v.value === "@me" ? "@me".startsWith(partial) : true).slice(0, 10);
        }
        case "tag":
          return (await tx.tag.findMany({ where: { workspaceId, name: { startsWith: partial, mode: "insensitive" } }, select: { name: true }, take: 10, orderBy: { name: "asc" } })).map((t) => ({ value: t.name, label: t.name }));
        case "updated":
          return ["<1d", "<7d", "<30d", ">30d"].map((v) => ({ value: v, label: v }));
        default: {
          const dim = dims.find((d) => d.key === key);
          if (!dim) return [];
          const rows = await tx.dimensionValue.findMany({
            where: { dimensionId: dim.id, isActive: true, OR: [{ code: { startsWith: partial, mode: "insensitive" } }, { label: { startsWith: partial, mode: "insensitive" } }] },
            select: { code: true, label: true },
            take: 10,
            orderBy: { label: "asc" },
          });
          return rows.map((v) => ({ value: v.code, label: v.label }));
        }
      }
    };
    return { keys: [], values: await values(), key };
  });
}
