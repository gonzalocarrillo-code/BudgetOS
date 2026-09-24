import { QueryRequest, resolvePeriod, type FilterGroupT } from "@budget/domain";
import { envelopePaths, plannerOptions, type SearchDoc, type Tx } from "@budget/db";
import { compileQuery, pageOf } from "@budget/query-planner";
import { Decimal } from "decimal.js";

/**
 * Search documents per entity type (spec §12.1 buildDocument*), built in batches: `ids = null`
 * builds every entity of the type in the workspace (full re-index). Each builder returns the
 * documents to upsert and the ids whose document must go (deleted comments, merged-away tags).
 */

export interface IndexContext {
  workspaceId: string;
  orgId: string;
  today: string;
}
export interface Built {
  upserts: SearchDoc[];
  deletes: string[];
}
export type IndexedType = "envelope" | "target" | "approval_request" | "alert" | "comment" | "tag" | "dimension_value";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const money = (v: unknown) => (v === null || v === undefined ? null : new Decimal(String(v)).toFixed(2));
const num = (v: unknown) => (v === null || v === undefined ? null : new Decimal(String(v)).toDecimalPlaces(4).toString());
const upper = (s: string | null | undefined) => (s ? s.toUpperCase() : null);
const byIds = (ids: string[] | null) => (ids === null ? {} : { id: { in: ids } });

/** FY2026, 2026-Q3 or 2026-07 when the dates are exactly that fiscal period, else null. */
export function periodKey(start: Date, end: Date, fiscalStartMonth: number): string | null {
  const e = iso(end);
  const y = start.getUTCFullYear();
  const m = start.getUTCMonth() + 1;
  const lastDay = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10);
  if (start.getUTCDate() !== 1) return null;
  if (m === fiscalStartMonth && e === lastDay(y + 1, m - 1)) return `FY${y}`;
  const offset = (m - fiscalStartMonth + 12) % 12;
  if (offset % 3 === 0 && e === lastDay(y, m + 2)) {
    const fy = m >= fiscalStartMonth ? y : y - 1;
    return `${fy}-Q${offset / 3 + 1}`;
  }
  if (e === lastDay(y, m)) return `${y}-${String(m).padStart(2, "0")}`;
  return null;
}

async function tagsOf(tx: Tx, entityType: string, ids: string[]): Promise<Map<string, string[]>> {
  const rows = await tx.taggable.findMany({ where: { entityType, entityId: { in: ids } }, select: { entityId: true, tagId: true } });
  const names = new Map((await tx.tag.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.tagId))] } }, select: { id: true, name: true } })).map((t) => [t.id, t.name]));
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.entityId, [...(out.get(r.entityId) ?? []), names.get(r.tagId) ?? ""].filter(Boolean).sort());
  return out;
}

/** Budget, actual, pace and CPA vs target for the current fiscal year, from the planner (never stored elsewhere). */
async function envelopeFacets(tx: Tx, ctx: IndexContext, fiscalStart: number, names: string[] | null): Promise<Map<string, Record<string, string | null>>> {
  const period = resolvePeriod({ kind: "relative", preset: "current_year" }, ctx.today, fiscalStart);
  const opts = await plannerOptions(tx, ctx, ["cpa"], period);
  const targets = opts.metrics?.has("cpa") ? ["cpa"] : [];
  const filter: FilterGroupT | undefined = names === null ? undefined : { logic: "and", children: [{ field: { kind: "attr", key: "name" }, op: "in", value: names }] };
  const out = new Map<string, Record<string, string | null>>();
  let cursor: string | null = null;
  do {
    const q = QueryRequest.parse({ workspaceId: ctx.workspaceId, ...(filter ? { filter } : {}), measures: ["budget", "actual", "pace_index"], targets, period: { kind: "range", ...period }, limit: 1000, ...(cursor ? { cursor } : {}) });
    const c = compileQuery(q, period, ctx.today, opts);
    const page = pageOf(c, await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(c.sql, ...c.values), q.limit);
    for (const r of page.rows) {
      out.set(String(r["envelope_id"]), { budget: money(r["budget"]), actual: money(r["actual"]), pace_index: num(r["pace_index"]), cpa: num(r["kpi_cpa"]), cpa_target: num(r["tgt_cpa"]) });
    }
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

export async function buildEnvelopes(tx: Tx, ctx: IndexContext, ids: string[] | null): Promise<Built> {
  const ws = await tx.workspace.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { fiscalYearStartMonth: true } });
  const envs = await tx.envelope.findMany({ where: { workspaceId: ctx.workspaceId, ...byIds(ids) } });
  if (envs.length === 0) return { upserts: [], deletes: ids ?? [] };
  const envIds = envs.map((e) => e.id);
  const [paths, tags, facets] = await Promise.all([
    envelopePaths(tx, envIds),
    tagsOf(tx, "envelope", envIds),
    envelopeFacets(tx, ctx, ws.fiscalYearStartMonth, ids === null ? null : [...new Set(envs.map((e) => e.name))]),
  ]);
  const versions = await tx.envelopeVersion.findMany({ where: { envelopeId: { in: envIds }, rationale: { not: null } }, select: { envelopeId: true, rationale: true }, orderBy: { createdAt: "desc" } });
  const dims = await tx.envelopeDimension.findMany({ where: { envelopeId: { in: envIds } }, select: { envelopeId: true, valueId: true } });
  const values = new Map((await tx.dimensionValue.findMany({ where: { id: { in: [...new Set(dims.map((d) => d.valueId))] } }, select: { id: true, label: true, aliases: true, externalIds: true } })).map((v) => [v.id, v]));
  return {
    upserts: envs.map((e) => {
      const rationales = versions.filter((v) => v.envelopeId === e.id).slice(0, 5).map((v) => v.rationale as string);
      const labels = dims.filter((d) => d.envelopeId === e.id).flatMap((d) => {
        const v = values.get(d.valueId);
        return v ? [v.label, ...v.aliases, ...Object.values((v.externalIds ?? {}) as Record<string, unknown>).map(String)] : [];
      });
      return {
        workspaceId: ctx.workspaceId,
        entityType: "envelope",
        entityId: e.id,
        title: e.name,
        path: (paths.get(e.id) ?? [e.name]).join(" › "),
        body: [...rationales, ...labels, ...Object.values(e.dimensionValues as Record<string, string>)].join("\n"),
        tags: tags.get(e.id) ?? [],
        dimensionValues: e.dimensionValues as Record<string, string>,
        numericFacets: facets.get(e.id) ?? {},
        ownerId: e.ownerId,
        status: upper(e.status),
        periodKey: periodKey(e.startDate, e.endDate, ws.fiscalYearStartMonth),
      };
    }),
    deletes: ids === null ? [] : ids.filter((id) => !envIds.includes(id)),
  };
}

export async function buildTargets(tx: Tx, ctx: IndexContext, ids: string[] | null): Promise<Built> {
  const ws = await tx.workspace.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { fiscalYearStartMonth: true } });
  const targets = await tx.target.findMany({ where: { workspaceId: ctx.workspaceId, ...byIds(ids) }, include: { versions: { orderBy: { versionNo: "desc" } } } });
  const envIds = targets.map((t) => t.envelopeId).filter((x): x is string => x !== null);
  const envs = new Map((await tx.envelope.findMany({ where: { id: { in: envIds } }, select: { id: true, name: true, dimensionValues: true } })).map((e) => [e.id, e]));
  const paths = await envelopePaths(tx, envIds);
  const tags = await tagsOf(tx, "target", targets.map((t) => t.id));
  return {
    upserts: targets.map((t) => {
      const env = t.envelopeId ? envs.get(t.envelopeId) : undefined;
      const current = t.versions.find((v) => v.id === t.currentVersionId);
      return {
        workspaceId: ctx.workspaceId,
        entityType: "target",
        entityId: t.id,
        title: `${t.metricKey.toUpperCase()} target · ${env?.name ?? "filter scope"}`,
        path: t.envelopeId ? (paths.get(t.envelopeId) ?? []).join(" › ") : "",
        body: t.versions.map((v) => v.rationale).filter(Boolean).join("\n"),
        tags: tags.get(t.id) ?? [],
        dimensionValues: (env?.dimensionValues ?? {}) as Record<string, string>,
        numericFacets: { value: current ? num(current.value) : null },
        ownerId: t.ownerId,
        status: upper(t.status),
        periodKey: periodKey(t.startDate, t.endDate, ws.fiscalYearStartMonth),
      };
    }),
    deletes: ids === null ? [] : ids.filter((id) => !targets.some((t) => t.id === id)),
  };
}

export async function buildApprovals(tx: Tx, ctx: IndexContext, ids: string[] | null): Promise<Built> {
  const requests = await tx.approvalRequest.findMany({ where: { workspaceId: ctx.workspaceId, ...byIds(ids) } });
  const versionIds = requests.filter((r) => r.entityType === "envelope_version").map((r) => r.entityId);
  const versions = new Map((await tx.envelopeVersion.findMany({ where: { id: { in: versionIds } }, select: { id: true, envelopeId: true, envelope: { select: { dimensionValues: true } } } })).map((v) => [v.id, v]));
  const paths = await envelopePaths(tx, [...versions.values()].map((v) => v.envelopeId));
  const tags = await tagsOf(tx, "approval_request", requests.map((r) => r.id));
  return {
    upserts: requests.map((r) => {
      const v = versions.get(r.entityId);
      return {
        workspaceId: ctx.workspaceId,
        entityType: "approval_request",
        entityId: r.id,
        title: `Approval · ${(r.summary.split("\n")[0] ?? "").slice(0, 120)}`,
        path: v ? (paths.get(v.envelopeId) ?? []).join(" › ") : "",
        body: [r.summary, r.entityType, r.id].join("\n"),
        tags: tags.get(r.id) ?? [],
        dimensionValues: (v?.envelope.dimensionValues ?? {}) as Record<string, string>,
        numericFacets: {},
        ownerId: r.requestedBy,
        status: upper(r.status),
        periodKey: null,
      };
    }),
    deletes: ids === null ? [] : ids.filter((id) => !requests.some((r) => r.id === id)),
  };
}

export async function buildAlerts(tx: Tx, ctx: IndexContext, ids: string[] | null): Promise<Built> {
  const alerts = await tx.alert.findMany({ where: { workspaceId: ctx.workspaceId, ...byIds(ids) } });
  const rules = new Map((await tx.pacingRule.findMany({ where: { id: { in: [...new Set(alerts.map((a) => a.ruleId))] } }, select: { id: true, name: true } })).map((r) => [r.id, r.name]));
  const envs = new Map((await tx.envelope.findMany({ where: { id: { in: [...new Set(alerts.map((a) => a.envelopeId))] } }, select: { id: true, name: true, dimensionValues: true } })).map((e) => [e.id, e]));
  const paths = await envelopePaths(tx, [...envs.keys()]);
  const tags = await tagsOf(tx, "alert", alerts.map((a) => a.id));
  return {
    upserts: alerts.map((a) => {
      const env = envs.get(a.envelopeId);
      return {
        workspaceId: ctx.workspaceId,
        entityType: "alert",
        entityId: a.id,
        title: `${rules.get(a.ruleId) ?? "Alert"} · ${env?.name ?? ""}`,
        path: (paths.get(a.envelopeId) ?? []).join(" › "),
        body: `${a.severity} ${a.metricValue.toString()} vs ${a.threshold.toString()}`,
        tags: tags.get(a.id) ?? [],
        dimensionValues: (env?.dimensionValues ?? {}) as Record<string, string>,
        numericFacets: { value: num(a.metricValue), threshold: num(a.threshold) },
        ownerId: a.ownerId,
        status: upper(a.status),
        periodKey: null,
      };
    }),
    deletes: ids === null ? [] : ids.filter((id) => !alerts.some((a) => a.id === id)),
  };
}

/** The envelope a thread anchor belongs to, for the comment's path and dimension scope. */
async function anchorEnvelopes(tx: Tx, threads: Array<{ id: string; anchorType: string; anchorId: string }>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const idsOf = (types: string[]) => threads.filter((t) => types.includes(t.anchorType)).map((t) => t.anchorId);
  for (const t of threads) if (t.anchorType === "envelope" || t.anchorType === "cell") out.set(t.id, t.anchorId);
  const versions = new Map((await tx.envelopeVersion.findMany({ where: { id: { in: idsOf(["envelope_version"]) } }, select: { id: true, envelopeId: true } })).map((v) => [v.id, v.envelopeId]));
  const targets = new Map((await tx.target.findMany({ where: { id: { in: idsOf(["target"]) } }, select: { id: true, envelopeId: true } })).map((x) => [x.id, x.envelopeId]));
  const alerts = new Map((await tx.alert.findMany({ where: { id: { in: idsOf(["alert"]) } }, select: { id: true, envelopeId: true } })).map((x) => [x.id, x.envelopeId]));
  for (const t of threads) {
    const e = t.anchorType === "envelope_version" ? versions.get(t.anchorId) : t.anchorType === "target" ? targets.get(t.anchorId) : t.anchorType === "alert" ? alerts.get(t.anchorId) : undefined;
    if (e) out.set(t.id, e);
  }
  return out;
}

export async function buildComments(tx: Tx, ctx: IndexContext, ids: string[] | null): Promise<Built> {
  const comments = await tx.comment.findMany({ where: { ...byIds(ids), thread: { workspaceId: ctx.workspaceId } }, include: { thread: true } });
  const live = comments.filter((c) => c.deletedAt === null);
  const threads = [...new Map(live.map((c) => [c.thread.id, c.thread])).values()];
  const anchorEnv = await anchorEnvelopes(tx, threads);
  const envs = new Map((await tx.envelope.findMany({ where: { id: { in: [...new Set(anchorEnv.values())] } }, select: { id: true, dimensionValues: true } })).map((e) => [e.id, e]));
  const paths = await envelopePaths(tx, [...envs.keys()]);
  return {
    upserts: live.map((c) => {
      const envId = anchorEnv.get(c.threadId);
      return {
        workspaceId: ctx.workspaceId,
        entityType: "comment",
        entityId: c.id,
        title: c.thread.title ?? c.bodyMd.replace(/\s+/g, " ").slice(0, 80),
        path: envId ? (paths.get(envId) ?? []).join(" › ") : c.thread.anchorType,
        body: c.bodyMd,
        tags: [],
        dimensionValues: (envId ? (envs.get(envId)?.dimensionValues ?? {}) : {}) as Record<string, string>,
        numericFacets: {},
        ownerId: c.authorId,
        status: upper(c.thread.status),
        periodKey: null,
      };
    }),
    deletes: [...comments.filter((c) => c.deletedAt !== null).map((c) => c.id), ...(ids === null ? [] : ids.filter((id) => !comments.some((c) => c.id === id)))],
  };
}

export async function buildTags(tx: Tx, ctx: IndexContext, ids: string[] | null): Promise<Built> {
  const tags = await tx.tag.findMany({ where: { workspaceId: ctx.workspaceId, ...byIds(ids) } });
  const counts = await tx.taggable.groupBy({ by: ["tagId"], where: { tagId: { in: tags.map((t) => t.id) } }, _count: { _all: true } });
  return {
    upserts: tags.map((t) => ({
      workspaceId: ctx.workspaceId,
      entityType: "tag",
      entityId: t.id,
      title: t.name,
      path: "Tags",
      body: t.kind,
      tags: [t.name],
      dimensionValues: {},
      numericFacets: { count: String(counts.find((c) => c.tagId === t.id)?._count._all ?? 0) },
      ownerId: t.createdBy,
      status: null,
      periodKey: null,
    })),
    deletes: ids === null ? [] : ids.filter((id) => !tags.some((t) => t.id === id)),
  };
}

/** Registry values the workspace sees; `dimensionIds` narrows to some dimensions (null = all). */
export async function buildDimensionValues(tx: Tx, ctx: IndexContext, dimensionIds: string[] | null): Promise<Built> {
  const dims = await tx.dimension.findMany({ where: { orgId: ctx.orgId, OR: [{ workspaceId: null }, { workspaceId: ctx.workspaceId }], ...(dimensionIds ? { id: { in: dimensionIds } } : {}) }, select: { id: true, label: true, key: true } });
  const values = await tx.dimensionValue.findMany({ where: { dimensionId: { in: dims.map((d) => d.id) } }, select: { id: true, dimensionId: true, code: true, label: true, aliases: true, externalIds: true, parentValueId: true, isActive: true, mergedIntoId: true } });
  const byId = new Map(values.map((v) => [v.id, v]));
  const chain = (id: string | null): string[] => {
    const out: string[] = [];
    for (let v = id ? byId.get(id) : undefined, guard = 0; v && guard < 16; v = v.parentValueId ? byId.get(v.parentValueId) : undefined, guard += 1) out.unshift(v.label);
    return out;
  };
  return {
    upserts: values.map((v) => {
      const d = dims.find((x) => x.id === v.dimensionId);
      return {
        workspaceId: ctx.workspaceId,
        entityType: "dimension_value",
        entityId: v.id,
        title: v.label,
        path: [d?.label ?? "", ...chain(v.parentValueId)].join(" › "),
        body: [v.code, ...v.aliases, ...Object.values((v.externalIds ?? {}) as Record<string, unknown>).map(String), d?.key ?? ""].join("\n"),
        tags: [],
        dimensionValues: {},
        numericFacets: {},
        ownerId: null,
        status: v.mergedIntoId ? "MERGED" : v.isActive ? "ACTIVE" : "RETIRED",
        periodKey: null,
      };
    }),
    deletes: [],
  };
}

export const BUILDERS: Record<IndexedType, (tx: Tx, ctx: IndexContext, ids: string[] | null) => Promise<Built>> = {
  envelope: buildEnvelopes,
  target: buildTargets,
  approval_request: buildApprovals,
  alert: buildAlerts,
  comment: buildComments,
  tag: buildTags,
  dimension_value: buildDimensionValues,
};
