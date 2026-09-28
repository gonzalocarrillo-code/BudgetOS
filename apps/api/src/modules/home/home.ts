import { QueryRequest, canInScope, elapsedFraction, resolvePeriod, type FilterGroupT, type HomeResponse } from "@budget/domain";
import { headline } from "../../common/headline.js";
import { plannerOptions, unmatchedSpend, withTenant, fiscalCalendar, workspaceSetup } from "@budget/db";
import { compileQuery, compileTotals } from "@budget/query-planner";
import { Decimal } from "decimal.js";
import type { PrismaClient } from "@prisma/client";
import { requireWorkspace } from "../../common/parse-input.js";
import { envelopeScopeTargets } from "../../common/scope.guard.js";
import type { AuthContext } from "../../common/tenant.js";
import { listApprovals } from "../approvals/queries/approvals.js";

/**
 * GET /me/home (spec §27, plan §11.7 "Home is a to-do list"): what is waiting on the caller first —
 * approvals they can decide now, comments mentioning them in open threads, alerts assigned to them,
 * unmatched spend — then a pacing strip per top-level budget they own or their roles cover (the
 * planner's totals over that budget's live leaves this fiscal year), then what they touched last
 * and their saved views. Each block carries what its screen needs to open filtered.
 */

const MAX_SCOPES = 8;
const money = (v: unknown) => (v === null || v === undefined ? null : new Decimal(String(v)).toFixed(2));
const ratio = (v: unknown) => (v === null || v === undefined ? null : new Decimal(String(v)).toDecimalPlaces(4).toString());

export async function getHome(prisma: PrismaClient, auth: AuthContext, now: Date = new Date()): Promise<HomeResponse> {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const approvals = (await listApprovals(prisma, auth, { assignee: "me", limit: "10" } as never)).rows as Array<{ id: string; summary: string | null; entityType: string; requestedAt: string; dueAt: string | null }>;
  return withTenant(prisma, auth.ctx, async (tx) => {
    const me = auth.user.id;
    const today = now.toISOString().slice(0, 10);

    // Mentions of me in open threads (not my own comments), newest first.
    const mentioned = await tx.comment.findMany({
      where: { deletedAt: null, authorId: { not: me }, mentions: { array_contains: [{ type: "user", id: me }] }, thread: { workspaceId, status: "open" } },
      include: { thread: { select: { id: true, anchorType: true, anchorId: true } } },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    const authors = new Map((await tx.user.findMany({ where: { id: { in: mentioned.map((c) => c.authorId) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));

    const alerts = await tx.alert.findMany({ where: { workspaceId, ownerId: me, status: { in: ["OPEN", "ACKNOWLEDGED"] } }, orderBy: { openedAt: "desc" }, take: 10 });
    const alertEnvelopes = new Map((await tx.envelope.findMany({ where: { id: { in: alerts.map((a) => a.envelopeId) } }, select: { id: true, name: true, displayName: true } })).map((e) => [e.id, e.displayName ?? e.name]));
    const unmatched = (await unmatchedSpend(tx, workspaceId, 1000)).reduce((n, g) => n + g.rows, 0);

    // Top-level budgets I own or my roles' read scope covers.
    const roots = await tx.envelope.findMany({ where: { workspaceId, parentId: null, status: { not: "ARCHIVED" } }, select: { id: true, name: true, displayName: true, ownerId: true, dimensionValues: true }, orderBy: { name: "asc" } });
    const scopesOf = auth.isOrgAdmin ? null : await envelopeScopeTargets(tx, roots.map((r) => r.id));
    const mine = roots.filter((r) => r.ownerId === me || scopesOf === null || canInScope(auth.assignments, "envelope.read", scopesOf.get(r.id) ?? { dims: {} }));
    const picked = [...mine.filter((r) => r.ownerId === me), ...mine.filter((r) => r.ownerId !== me)].slice(0, MAX_SCOPES);
    const ws = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { fiscalYearStartMonth: true, name: true, reportingCurrency: true } });
    const period = resolvePeriod({ kind: "relative", preset: "current_year" }, today, ws.fiscalYearStartMonth, await fiscalCalendar(tx, workspaceId));
    const opts = await plannerOptions(tx, { orgId: auth.user.orgId, workspaceId }, [], period);
    // Each strip is that budget's own row in the budget structure (UX-008, ADR-051): its approved
    // amount against everything spent under it, found by parent links, not by dimension values.
    const scopes: HomeResponse["scopes"] = [];
    const rootRows = new Map<string, Record<string, unknown>>();
    if (picked.length > 0) {
      const rq = QueryRequest.parse({ workspaceId, filter: { logic: "and", children: [{ field: { kind: "attr", key: "parent_id" }, op: "is_empty" }, { field: { kind: "attr", key: "status" }, op: "neq", value: "ARCHIVED" }] }, period: { kind: "range", ...period }, measures: ["budget", "actual", "projected", "pace_index", "spend_to_date_pct"], subtree: true, limit: 500 });
      const cq = compileQuery(rq, period, today, opts);
      for (const row of await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(cq.sql, ...cq.values)) rootRows.set(String(row["envelope_id"]), row);
    }
    for (const r of picked) {
      const dims = Object.entries((r.dimensionValues ?? {}) as Record<string, string>);
      // The link opens Budgets on this budget's granularities; the numbers are the budget's own row.
      const filter: FilterGroupT = { logic: "and", children: dims.map(([key, value]) => ({ field: { kind: "dimension", key }, op: "eq", value })) };
      const row = rootRows.get(r.id);
      scopes.push({ label: r.displayName ?? r.name, filter, envelopeId: r.id, budget: money(row?.["budget"]), actual: money(row?.["actual"]), projected: money(row?.["projected"]), paceIndex: ratio(row?.["pace_index"]), spentPct: ratio(row?.["spend_to_date_pct"]) });
    }

    // What I touched last: the latest audit event per entity I acted on.
    const touched = await tx.$queryRaw<Array<{ entity_type: string; entity_id: string; at: Date }>>`
      SELECT entity_type, entity_id::text, max(occurred_at) AS at FROM audit_event
      WHERE workspace_id = ${workspaceId}::uuid AND actor_id = ${me}::uuid AND entity_type IN ('envelope', 'approval_request', 'experiment', 'manual_entry', 'target')
      GROUP BY entity_type, entity_id ORDER BY max(occurred_at) DESC LIMIT 8`;
    const ids = (type: string) => touched.filter((x) => x.entity_type === type).map((x) => x.entity_id);
    const titles = new Map<string, string>([
      ...(await tx.envelope.findMany({ where: { id: { in: ids("envelope") } }, select: { id: true, name: true, displayName: true } })).map((e) => [e.id, e.displayName ?? e.name] as [string, string]),
      ...(await tx.approvalRequest.findMany({ where: { id: { in: ids("approval_request") } }, select: { id: true, summary: true } })).map((a) => [a.id, a.summary] as [string, string]),
      ...(await tx.experiment.findMany({ where: { id: { in: ids("experiment") } }, select: { id: true, name: true } })).map((x) => [x.id, x.name] as [string, string]),
      ...(await tx.manualEntryBatch.findMany({ where: { id: { in: ids("manual_entry") } }, select: { id: true, channel: true, periodStart: true } })).map((b) => [b.id, `${b.channel} · ${b.periodStart.toISOString().slice(0, 7)}`] as [string, string]),
      ...(await tx.target.findMany({ where: { id: { in: ids("target") } }, select: { id: true, metricKey: true } })).map((x) => [x.id, `${x.metricKey.toUpperCase()} target`] as [string, string]),
    ]);

    // Budgets views only (Overview layouts are not places to open); mine, then the workspace's.
    const views = await tx.savedView.findMany({ where: { workspaceId, screen: "explorer", OR: [{ createdBy: me }, { visibility: "workspace" }] }, orderBy: [{ visibility: "asc" }, { name: "asc" }], take: 6 });

    // The year so far over every budget the caller may read (Home's header numbers).
    const setup = await workspaceSetup(tx, workspaceId);
    let totals: HomeResponse["totals"] = null;
    // The same definition as Budgets (UX-008): top-level budgets, or the caller's scope. Someone with
    // no role that reads budgets gets no totals.
    const head = headline(auth);
    if (setup.budgets > 0 && head !== undefined) {
      const q = QueryRequest.parse({ workspaceId, filter: head.filter, subtree: head.subtree, period: { kind: "range", ...period }, measures: ["budget", "actual", "spend_to_date_pct"], limit: 1 });
      const tt = compileTotals(q, period, today, opts);
      const [row] = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(tt.sql, ...tt.values);
      const openAlerts = await tx.alert.count({ where: { workspaceId, status: { in: ["OPEN", "ACKNOWLEDGED"] } } });
      totals = { budget: money(row?.["budget"]), actual: money(row?.["actual"]), spentPct: ratio(row?.["spend_to_date_pct"]), openAlerts };
    }

    // UX-011: two recent budgets with the same name (two "LATAM"s) read with their parent's name.
    const recentIds = ids("envelope");
    const parents = new Map((await tx.envelope.findMany({ where: { id: { in: recentIds } }, select: { id: true, parentId: true } })).map((e) => [e.id, e.parentId]));
    const parentNames = new Map((await tx.envelope.findMany({ where: { id: { in: [...parents.values()].filter((x): x is string => x !== null) } }, select: { id: true, name: true, displayName: true } })).map((e) => [e.id, e.displayName ?? e.name]));
    const seen = new Map<string, number>();
    for (const x of touched) if (titles.has(x.entity_id)) seen.set(titles.get(x.entity_id) as string, (seen.get(titles.get(x.entity_id) as string) ?? 0) + 1);
    for (const id of recentIds) {
      const title = titles.get(id);
      const parent = parentNames.get(parents.get(id) ?? "");
      if (title && parent && (seen.get(title) ?? 0) > 1) titles.set(id, `${title} · ${parent}`);
    }

    return {
      waitingOnMe: {
        approvals: approvals.map((a) => ({ id: a.id, summary: a.summary, entityType: a.entityType, requestedAt: a.requestedAt, dueAt: a.dueAt })),
        mentions: mentioned.map((c) => ({ commentId: c.id, threadId: c.thread.id, anchorType: c.thread.anchorType, anchorId: c.thread.anchorId, body: c.bodyMd.slice(0, 280), author: authors.get(c.authorId) ?? null, createdAt: c.createdAt.toISOString() })),
        alerts: alerts.map((a) => ({ id: a.id, envelopeId: a.envelopeId, envelopeName: alertEnvelopes.get(a.envelopeId) ?? "", severity: a.severity, openedAt: a.openedAt.toISOString() })),
        unmatched,
      },
      scopes,
      recents: touched.filter((x) => titles.has(x.entity_id)).map((x) => ({ entityType: x.entity_type, entityId: x.entity_id, title: titles.get(x.entity_id) as string, at: new Date(x.at).toISOString() })),
      pinnedViews: views.map((v) => ({ id: v.id, name: v.name, screen: v.screen, definition: v.definition as Record<string, unknown> })),
      workspace: { name: ws.name, currency: ws.reportingCurrency, period: { start: period.start, end: period.end, elapsed: ratio(elapsedFraction(period, today).toString()) } },
      totals,
      setup,
    };
  });
}
