import { DEFAULT_COLUMN_SYNONYMS, DEFAULT_METRIC_SYNONYMS, MappingPreviewInput, MatchMappingProfileInput, SourceMapping, compileParsePattern, normTerm, type ColumnMapping, type MappingPreviewReport, type MappingProfileView, type MappingSynonymView, type MappingSynonymsResponse, type MatchMappingProfileResponse } from "@budget/domain";
import { withTenant, type Tx } from "@budget/db";
import { loadRegistry, normalize, transformDimension, type RegistryIndex } from "@budget/workers";
import type { MappingProfile, PrismaClient } from "@prisma/client";
import { parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";

/** Reads for mapping profiles, synonyms and the mapping preview (docs/DATA_PLAN.md §2.3, D-004 to D-006). */

export function profileView(p: MappingProfile, sources: number): MappingProfileView {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind as MappingProfileView["kind"],
    mapping: p.mapping as MappingProfileView["mapping"],
    parsePattern: p.parsePattern,
    header: p.header,
    sources,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    archivedAt: p.archivedAt?.toISOString() ?? null,
  };
}

async function profiles(tx: Tx, workspaceId: string, includeArchived: boolean): Promise<MappingProfileView[]> {
  const rows = await tx.mappingProfile.findMany({ where: { workspaceId, ...(includeArchived ? {} : { archivedAt: null }) }, orderBy: { name: "asc" } });
  const counts = await tx.dataSource.groupBy({ by: ["mappingProfileId"], where: { mappingProfileId: { in: rows.map((r) => r.id) } }, _count: true });
  const byId = new Map(counts.map((c) => [c.mappingProfileId, c._count]));
  return rows.map((r) => profileView(r, byId.get(r.id) ?? 0));
}

/** GET /workspaces/:ws/mapping-profiles. */
export async function listMappingProfiles(prisma: PrismaClient, auth: AuthContext, raw: { includeArchived?: string } = {}) {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => ({ profiles: await profiles(tx, workspaceId, raw.includeArchived === "true") }));
}

/**
 * POST /workspaces/:ws/mapping-profiles/match: the profile whose columns are exactly the file's
 * (`exact`), else one whose columns are all in the file (`covers`, the most columns first).
 * Headers compare in the guesser's normal form, so "Spend" and "spend " are the same column.
 */
export async function matchMappingProfile(prisma: PrismaClient, auth: AuthContext, raw: unknown): Promise<MatchMappingProfileResponse> {
  const input = parseInput(MatchMappingProfileInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const file = new Set(input.header.map(normTerm));
  return withTenant(prisma, auth.ctx, async (tx) => {
    const all = await profiles(tx, workspaceId, false);
    const cols = (p: MappingProfileView) => new Set(p.header.map(normTerm));
    const exact = all.find((p) => { const c = cols(p); return c.size === file.size && [...c].every((h) => file.has(h)); });
    if (exact) return { profile: exact, fit: "exact" };
    const covers = all.filter((p) => [...cols(p)].every((h) => file.has(h))).sort((a, b) => b.header.length - a.header.length)[0];
    return covers ? { profile: covers, fit: "covers" } : { profile: null, fit: null };
  });
}

/** Built-in words, then the workspace's own (learned and manual); a workspace row replaces a built-in one. */
async function effectiveSynonyms(tx: Tx, workspaceId: string): Promise<MappingSynonymsResponse> {
  const rows = await tx.mappingSynonym.findMany({ where: { workspaceId }, orderBy: [{ kind: "asc" }, { term: "asc" }] });
  const own = (kind: "column" | "metric"): MappingSynonymView[] =>
    rows.filter((r) => r.kind === kind).map((r) => ({ id: r.id, kind, term: r.term, target: r.target as MappingSynonymView["target"], origin: r.origin as "learned" | "manual", uses: r.uses, isActive: r.isActive }));
  const merge = (kind: "column" | "metric", builtin: ReadonlyArray<{ term: string; target: MappingSynonymView["target"] }>): MappingSynonymView[] => {
    const mine = own(kind);
    const taken = new Set(mine.map((m) => m.term));
    return [...mine, ...builtin.filter((b) => !taken.has(b.term)).map((b) => ({ id: null, kind, term: b.term, target: b.target, origin: "builtin" as const, uses: 0, isActive: true }))];
  };
  return { columns: merge("column", DEFAULT_COLUMN_SYNONYMS), metrics: merge("metric", DEFAULT_METRIC_SYNONYMS), ratioWords: [] };
}

/** GET /workspaces/:ws/mapping-synonyms. */
export async function listMappingSynonyms(prisma: PrismaClient, auth: AuthContext): Promise<MappingSynonymsResponse> {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const syn = await effectiveSynonyms(tx, workspaceId);
    return { ...syn, ratioWords: [...(await ratioMetricWords(tx, auth.user.orgId, workspaceId, syn)).keys()].sort() };
  });
}

/** The synonyms as prompt hints for @budget/ai: what a header usually means here, and which words are ratios. */
export async function mappingHints(tx: Tx, workspaceId: string, orgId: string): Promise<{ columns: Record<string, unknown>; ratioWords: string[] }> {
  const syn = await effectiveSynonyms(tx, workspaceId);
  const ratios = await ratioMetricWords(tx, orgId, workspaceId, syn);
  return { columns: Object.fromEntries(syn.columns.filter((c) => c.isActive).slice(0, 80).map((c) => [c.term, c.target])), ratioWords: [...ratios.keys()] };
}

/** Normal-form words that name a ratio metric (a metric with a denominator: CPA, ROAS, CTR…) → the metric's label. */
async function ratioMetricWords(tx: Tx, orgId: string, workspaceId: string, syn?: MappingSynonymsResponse): Promise<Map<string, string>> {
  const metrics = await tx.metricDefinition.findMany({ where: { orgId, denominator: { not: null }, OR: [{ workspaceId: null }, { workspaceId }] }, select: { key: true, label: true } });
  const words = new Map<string, string>();
  for (const m of metrics) {
    words.set(normTerm(m.key), m.label);
    words.set(normTerm(m.label), m.label);
  }
  for (const s of (syn ?? (await effectiveSynonyms(tx, workspaceId))).metrics) {
    const metric = (s.target as { metric?: string }).metric;
    const hit = metrics.find((m) => m.key === metric);
    if (s.isActive && hit) words.set(s.term, hit.label);
  }
  return words;
}

/** Levenshtein distance; the preview's "did you mean" for an unknown value. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cur = row[j] as number;
      row[j] = Math.min((row[j] as number) + 1, (row[j - 1] as number) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length] as number;
}

/** The code whose code, label or alias is closest to `raw`, when it is close enough to be a typo. */
function nearest(raw: string, candidates: Array<{ code: string; names: string[] }>): string | null {
  const target = normTerm(raw);
  let best: { code: string; d: number; len: number } | null = null;
  for (const c of candidates) {
    for (const n of c.names) {
      const name = normTerm(n);
      const d = distance(target, name);
      if (best === null || d < best.d) best = { code: c.code, d, len: name.length };
    }
  }
  return best && best.d <= Math.max(1, Math.floor(Math.max(target.length, best.len) * 0.34)) ? best.code : null;
}

function describe(c: ColumnMapping | undefined, dimensionLabel: (k: string) => string): string {
  if (!c) return "not mapped";
  if ("dimension" in c) return dimensionLabel(c.dimension);
  if (c.role === "kpi") return `KPI ${c.metric}`;
  if (c.role === "projection") return `Projection ${c.metric}`;
  if (c.role === "ignore") return "left out";
  return c.role.replace(/_/g, " ");
}

/**
 * POST /workspaces/:ws/mapping-preview (D-006): the mapping run over a sample exactly as ingestion
 * would run it (same registry, same normalizer), before any source or run exists. It says what each
 * column becomes, which values the registry does not know (with the nearest one), which columns are
 * ratios BudgetOS computes itself, which KPIs no metric reads yet, and which rows would be rejected
 * and why. Nothing is written.
 */
export async function previewMapping(prisma: PrismaClient, auth: AuthContext, raw: unknown): Promise<MappingPreviewReport> {
  const input = parseInput(MappingPreviewInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const registry: RegistryIndex = await loadRegistry(tx, auth.user.orgId, workspaceId);
    const dims = await tx.dimension.findMany({ where: { orgId: auth.user.orgId, isActive: true, OR: [{ workspaceId: null }, { workspaceId }] }, select: { key: true, label: true } });
    const label = (k: string) => dims.find((d) => d.key === k)?.label ?? k;
    const metrics = await tx.metricDefinition.findMany({ where: { orgId: auth.user.orgId, OR: [{ workspaceId: null }, { workspaceId }] }, select: { numerator: true, denominator: true } });
    const readKpis = new Set(metrics.flatMap((m) => [m.numerator, m.denominator]).filter((x): x is string => typeof x === "string" && x.startsWith("kpi:")).map((x) => x.slice(4)));
    const ratios = await ratioMetricWords(tx, auth.user.orgId, workspaceId);
    // "Did you mean": each mapped dimension's live values, by code, label and alias.
    const mapped = [...new Set(Object.values(input.mapping.columns).flatMap((c) => ("dimension" in c ? [c.dimension] : [])))];
    const dimRows = await tx.dimension.findMany({ where: { orgId: auth.user.orgId, isActive: true, key: { in: mapped }, OR: [{ workspaceId: null }, { workspaceId }] }, select: { id: true, key: true, workspaceId: true } });
    const valueRows = await tx.dimensionValue.findMany({ where: { dimensionId: { in: dimRows.map((d) => d.id) }, isActive: true }, select: { dimensionId: true, code: true, label: true, aliases: true } });
    const candidates = (key: string) => {
      const ids = new Set(dimRows.filter((d) => d.key === key).map((d) => d.id));
      return valueRows.filter((v) => ids.has(v.dimensionId)).map((v) => ({ code: v.code, names: [v.code, v.label, ...v.aliases] }));
    };

    const parsed = SourceMapping.safeParse(input.mapping);
    const problems = parsed.success ? [] : [...new Set(parsed.error.issues.map((i) => i.message))];
    const index = new Map(input.header.map((h, i) => [h, i]));
    const columns = input.header.map((column) => {
      const c = input.mapping.columns[column];
      const issues: string[] = [];
      const notes: string[] = [];
      const ratio = ratios.get(normTerm(column));
      if (ratio) {
        if (!c || ("role" in c && c.role === "ignore")) notes.push(`"${column}" is ${ratio}, a ratio: BudgetOS works it out from the counts it is made of, so it is left out.`);
        else issues.push(`"${column}" is ${ratio}, a ratio. Ratios cannot be added up across budgets; map the counts it is made of (spend, conversions…) and leave this column out.`);
      }
      if (c && "dimension" in c) {
        if (!registry.has(c.dimension)) issues.push(`The registry has no ${c.dimension}`);
        const counts = new Map<string, number>();
        const at = index.get(column) as number;
        for (const r of input.rows) {
          const v = r[at];
          const s = v === null || v === undefined ? "" : String(v).trim();
          if (s !== "") counts.set(s, (counts.get(s) ?? 0) + 1);
        }
        const values = [...counts].map(([rawValue, count]) => {
          const resolved = registry.resolve(c.dimension, transformDimension(rawValue, c));
          return "error" in resolved ? { raw: rawValue, code: null, suggestion: nearest(rawValue, candidates(c.dimension)), count } : { raw: rawValue, code: resolved.code, suggestion: null, count };
        });
        const unknown = values.filter((v) => v.code === null);
        if (unknown.length) issues.push(`${unknown.length} value${unknown.length === 1 ? "" : "s"} the registry does not know: ${unknown.slice(0, 5).map((v) => `"${v.raw}"${v.suggestion ? ` (did you mean ${v.suggestion}?)` : ""}`).join(", ")}`);
        return { column, mapsTo: describe(c, label), values, issues, notes };
      }
      if (c && "role" in c && c.role === "kpi" && !readKpis.has(c.metric)) notes.push(`No metric reads the KPI "${c.metric}" yet; it is stored, and shows as a KPI once a metric uses it (Settings › Metrics).`);
      return { column, mapsTo: describe(c, label), issues, notes };
    });

    // Every row through the ingest normalizer: what a run would reject, and why.
    let rejected = 0;
    const rejects: Array<{ row: number; reason: string }> = [];
    if (parsed.success) {
      const pattern = input.parsePattern ? compileParsePattern(input.parsePattern) : null;
      input.rows.forEach((r, i) => {
        const row = Object.fromEntries(input.header.map((h, j) => [h, r[j] ?? null]));
        const out = normalize(row, parsed.data, registry, "preview", { envelopes: new Map(), pattern });
        if ("rejected" in out) {
          rejected += 1;
          if (rejects.length < 10) rejects.push({ row: i + 2, reason: out.rejected }); // +1 header, 1-based
        }
      });
    }
    return { rowsChecked: input.rows.length, rowsRejected: rejected, problems, columns, rejects };
  });
}
