import { QueryRequest, can, canInScope, elapsedFraction, fiscalYearPeriods, matchesScope, resolvePeriod, type Action, type FilterGroupT, type HomeResponse } from "@budget/domain";
import { headline } from "../../common/headline.js";
import { closedPeriods, dataAsOf, envelopeLineage, failedRuns, fiscalCalendar, plannerOptions, recentActivity, unmatchedSpend, unsentDrafts, unsettledInPeriod, withTenant, workspaceSetup, type LineageStep, type Tx } from "@budget/db";
import { compileQuery, compileTotals, elapsedDay } from "@budget/query-planner";
import { Decimal } from "decimal.js";
import type { PrismaClient } from "@prisma/client";
import { requireWorkspace } from "../../common/parse-input.js";
import { envelopeScopeTargets } from "../../common/scope.guard.js";
import type { AuthContext } from "../../common/tenant.js";
import { listApprovals } from "../approvals/queries/approvals.js";
import { approvalQueue, requestCards, sentByMe } from "../approvals/queries/desk.js";
import { openAlerts, type OpenAlert } from "../pacing/queries.js";

/**
 * GET /me/home (spec §27, plan §11.7 "Home is a to-do list", docs/HOME_OVERVIEW_PLAN.md §3.1): the
 * signed-in person's desk. First what waits on them — approvals they can decide, their unsent drafts,
 * alerts on budgets that are theirs, mentions, and for the roles that act on them unmatched spend,
 * failed source runs and periods to close — then a strip per top-level budget they own or read, what
 * they did last, their requests still waiting, and the workspace's pulse (the Overview headline's
 * numbers). Each block carries what its screen needs to open filtered.
 */

const MAX_SCOPES = 8;
const RECENTS = 5;
const money = (v: unknown) => (v === null || v === undefined ? null : new Decimal(String(v)).toFixed(2));
const ratio = (v: unknown) => (v === null || v === undefined ? null : new Decimal(String(v)).toDecimalPlaces(4).toString());
const DAY = 86_400_000;
const dayNo = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY);
const SEVERITY_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2, data: 3 };

export async function getHome(prisma: PrismaClient, auth: AuthContext, now: Date = new Date()): Promise<HomeResponse> {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const me = auth.user.id;
  const may = (a: Action) => auth.isOrgAdmin || can(auth.roles, a);
  const [approvalPage, alertsOpen, queue, sent] = await Promise.all([
    listApprovals(prisma, auth, { assignee: "me", limit: "10" }),
    openAlerts(prisma, auth),
    approvalQueue(prisma, auth, now),
    sentByMe(prisma, auth, 10),
  ]);
  const approvals = approvalPage.rows as Array<{ id: string; summary: string | null; entityType: string; entityId?: string; versionId: string | null; manualEntryId: string | null; requestedAt: string; dueAt: string | null; requestedByName?: string | null }>;
  return withTenant(prisma, auth.ctx, async (tx) => {
    const today = now.toISOString().slice(0, 10);

    // Approvals I can decide, with what each one changes.
    const refs = await tx.approvalRequest.findMany({ where: { id: { in: approvals.map((a) => a.id) } }, select: { id: true, entityType: true, entityId: true, summary: true } });
    const cards = await requestCards(tx, refs);

    // Mentions of me in open threads (not my own comments), newest first.
    const mentioned = await tx.comment.findMany({
      where: { deletedAt: null, authorId: { not: me }, mentions: { array_contains: [{ type: "user", id: me }] }, thread: { workspaceId, status: "open" } },
      include: { thread: { select: { id: true, anchorType: true, anchorId: true } } },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    const authors = new Map((await tx.user.findMany({ where: { id: { in: mentioned.map((c) => c.authorId) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));

    // Alerts: those assigned to me, and those on budgets that are mine (HO-005).
    const assigned = alertsOpen.filter((a) => a.ownerId === me).slice(0, 10);
    const lineage = await envelopeLineage(tx, [...new Set(alertsOpen.map((a) => a.envelopeId))]);
    const names = new Map([...lineage.values()].flatMap((chain) => chain.map((s) => [s.id, s.name] as [string, string])));
    const alertsOnMyBudgets = await myAlertGroups(tx, auth, alertsOpen, lineage);

    // Unmatched spend and failed runs are for those who can map facts and fix sources.
    const canMap = may("source.manage");
    const unmatched = canMap ? (await unmatchedSpend(tx, workspaceId, 1000)).reduce((n, g) => n + g.rows, 0) : 0;
    const failed = canMap ? await failedRuns(tx, workspaceId, new Date(now.getTime() - 7 * DAY)) : [];
    const drafts = await unsentDrafts(tx, workspaceId, me, 3);

    // Top-level budgets I own or my roles' read scope covers.
    const roots = await tx.envelope.findMany({ where: { workspaceId, parentId: null, status: { not: "ARCHIVED" } }, select: { id: true, name: true, displayName: true, ownerId: true, dimensionValues: true }, orderBy: { name: "asc" } });
    const scopesOf = auth.isOrgAdmin ? null : await envelopeScopeTargets(tx, roots.map((r) => r.id));
    const readable = roots.filter((r) => r.ownerId === me || scopesOf === null || canInScope(auth.assignments, "envelope.read", scopesOf.get(r.id) ?? { dims: {} }));
    const picked = [...readable.filter((r) => r.ownerId === me), ...readable.filter((r) => r.ownerId !== me)].slice(0, MAX_SCOPES);
    const ws = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { fiscalYearStartMonth: true, name: true, reportingCurrency: true } });
    const calendar = await fiscalCalendar(tx, workspaceId);
    const period = resolvePeriod({ kind: "relative", preset: "current_year" }, today, ws.fiscalYearStartMonth, calendar);
    // HO-003 (ADR-062): pace counts time gone through the last day the actuals cover, as on the Overview.
    const asOf = await dataAsOf(tx, workspaceId, today);
    const opts = { ...(await plannerOptions(tx, { orgId: auth.user.orgId, workspaceId }, [], period)), elapsedThrough: asOf.through ?? undefined };

    // What is open under each top-level budget: alerts (the population above) and budgets waiting for approval.
    const rootOf = (chain: Array<{ id: string }> | undefined) => chain?.[chain.length - 1]?.id;
    const alertsUnder = new Map<string, number>();
    for (const a of alertsOpen) {
      const root = rootOf(lineage.get(a.envelopeId));
      if (root) alertsUnder.set(root, (alertsUnder.get(root) ?? 0) + 1);
    }
    const waiting = await tx.envelope.findMany({ where: { workspaceId, status: "PENDING" }, select: { id: true } });
    const pendingUnder = new Map<string, number>();
    for (const chain of (await envelopeLineage(tx, waiting.map((e) => e.id))).values()) {
      const root = rootOf(chain);
      if (root) pendingUnder.set(root, (pendingUnder.get(root) ?? 0) + 1);
    }

    // Each strip is that budget's own row in the budget structure (UX-008, ADR-051): its approved
    // amount against everything spent under it, found by parent links, not by dimension values.
    const scopes: HomeResponse["scopes"] = [];
    const rootRows = new Map<string, Record<string, unknown>>();
    if (picked.length > 0) {
      const rq = QueryRequest.parse({ workspaceId, filter: { logic: "and", children: [{ field: { kind: "attr", key: "parent_id" }, op: "is_empty" }, { field: { kind: "attr", key: "status" }, op: "neq", value: "ARCHIVED" }] }, period: { kind: "range", ...period }, measures: ["budget", "actual", "projected", "remaining", "pace_index", "spend_to_date_pct"], subtree: true, limit: 500 });
      const cq = compileQuery(rq, period, today, opts);
      for (const row of await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(cq.sql, ...cq.values)) rootRows.set(String(row["envelope_id"]), row);
    }
    for (const r of picked) {
      const dims = Object.entries((r.dimensionValues ?? {}) as Record<string, string>);
      // The filter opens Budgets on this budget's granularities (older links); the strip opens the budget itself.
      const filter: FilterGroupT = { logic: "and", children: dims.map(([key, value]) => ({ field: { kind: "dimension", key }, op: "eq", value })) };
      const row = rootRows.get(r.id);
      scopes.push({
        label: r.displayName ?? r.name,
        filter,
        envelopeId: r.id,
        budget: money(row?.["budget"]),
        actual: money(row?.["actual"]),
        projected: money(row?.["projected"]),
        remaining: money(row?.["remaining"]),
        paceIndex: ratio(row?.["pace_index"]),
        spentPct: ratio(row?.["spend_to_date_pct"]),
        owner: r.ownerId === me,
        alerts: alertsUnder.get(r.id) ?? 0,
        pending: pendingUnder.get(r.id) ?? 0,
      });
    }

    // Periods to close (HO-005): for those who close them, the quarters ending in the next two weeks
    // or ended in the last month, not closed yet, with what is still unsettled in them.
    const closures: NonNullable<HomeResponse["waitingOnMe"]["closures"]> = [];
    if (may("closure.close")) {
      // The workspace's own quarter rows (Admin › Fiscal calendar, or made by a close) win over the
      // calendar quarters of this fiscal year and the last.
      const month = Number(today.slice(5, 7));
      const fy = month >= ws.fiscalYearStartMonth ? Number(today.slice(0, 4)) : Number(today.slice(0, 4)) - 1;
      const byKey = new Map([fy - 1, fy].flatMap((y) => fiscalYearPeriods(y, ws.fiscalYearStartMonth, "calendar").filter((p) => p.kind === "quarter")).map((p) => [p.key, p] as const));
      for (const p of calendar.filter((c) => c.kind === "quarter")) byKey.set(p.key, p);
      const quarters = [...byKey.values()];
      const closed = new Set((await closedPeriods(tx, workspaceId)).map((c) => c.key));
      const t = dayNo(today);
      for (const q of quarters.filter((q) => !closed.has(q.key) && dayNo(q.end) >= t - 30 && dayNo(q.end) <= t + 14).sort((a, b) => a.end.localeCompare(b.end))) {
        closures.push({ periodKey: q.key, start: q.start, end: q.end, daysLeft: dayNo(q.end) - t, ...(await unsettledInPeriod(tx, workspaceId, q)) });
      }
    }

    // What I did last: the latest audit event per thing I acted on, with where it sits.
    const activity = (await recentActivity(tx, workspaceId, me, ["envelope", "approval_request", "experiment", "manual_entry", "target"], RECENTS * 2)).slice(0, RECENTS * 2);
    const ids = (type: string) => activity.filter((x) => x.entityType === type).map((x) => x.entityId);
    const envs = await tx.envelope.findMany({ where: { id: { in: ids("envelope") } }, select: { id: true, name: true, displayName: true, parentId: true } });
    const targets = await tx.target.findMany({ where: { id: { in: ids("target") } }, select: { id: true, metricKey: true, envelopeId: true } });
    const parentIds = [...envs.map((e) => e.parentId), ...targets.map((x) => x.envelopeId)].filter((x): x is string => x !== null);
    const parentNames = new Map((await tx.envelope.findMany({ where: { id: { in: parentIds } }, select: { id: true, name: true, displayName: true } })).map((e) => [e.id, e.displayName ?? e.name]));
    const requestTitles = await requestCards(tx, await tx.approvalRequest.findMany({ where: { id: { in: ids("approval_request") } }, select: { id: true, entityType: true, entityId: true, summary: true } }));
    const described = new Map<string, { title: string; parent: string | null }>([
      ...envs.map((e) => [e.id, { title: e.displayName ?? e.name, parent: e.parentId ? (parentNames.get(e.parentId) ?? null) : null }] as const),
      ...[...requestTitles].map(([id, c]) => [id, { title: c.title, parent: null }] as const),
      ...(await tx.experiment.findMany({ where: { id: { in: ids("experiment") } }, select: { id: true, name: true } })).map((x) => [x.id, { title: x.name, parent: null }] as const),
      ...(await tx.manualEntryBatch.findMany({ where: { id: { in: ids("manual_entry") } }, select: { id: true, channel: true, periodStart: true } })).map((b) => [b.id, { title: `${b.channel} · ${b.periodStart.toISOString().slice(0, 7)}`, parent: null }] as const),
      ...targets.map((x) => [x.id, { title: `${x.metricKey.toUpperCase()} target`, parent: x.envelopeId ? (parentNames.get(x.envelopeId) ?? null) : null }] as const),
    ]);

    // Budgets views only (Overview layouts are not places to open); mine, then the workspace's.
    const views = await tx.savedView.findMany({ where: { workspaceId, screen: "explorer", OR: [{ createdBy: me }, { visibility: "workspace" }] }, orderBy: [{ visibility: "asc" }, { name: "asc" }], take: 6 });

    // The year so far over every budget the caller may read: the pulse, the Overview headline's numbers.
    const setup = await workspaceSetup(tx, workspaceId);
    let totals: HomeResponse["totals"] = null;
    // The same definition as Budgets (UX-008): top-level budgets, or the caller's scope. Someone with
    // no role that reads budgets gets no totals.
    const head = headline(auth);
    if (setup.budgets > 0 && head !== undefined) {
      const q = QueryRequest.parse({ workspaceId, filter: head.filter, subtree: head.subtree, period: { kind: "range", ...period }, measures: ["budget", "actual", "spend_to_date_pct", "pace_index"], limit: 1 });
      const tt = compileTotals(q, period, today, opts);
      const [row] = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(tt.sql, ...tt.values);
      // HO-001: the Overview's count: open alerts the caller may read. HO-005: the approval queue too.
      totals = { budget: money(row?.["budget"]), actual: money(row?.["actual"]), spentPct: ratio(row?.["spend_to_date_pct"]), paceIndex: ratio(row?.["pace_index"]), openAlerts: alertsOpen.length, waiting: queue.waiting, overdue: queue.overdue };
    }

    return {
      waitingOnMe: {
        approvals: approvals.map((a) => ({ id: a.id, summary: a.summary, entityType: a.entityType, requestedAt: a.requestedAt, dueAt: a.dueAt, requestedByName: a.requestedByName ?? null, ...(cards.get(a.id) ?? {}) })),
        mentions: mentioned.map((c) => ({ commentId: c.id, threadId: c.thread.id, anchorType: c.thread.anchorType, anchorId: c.thread.anchorId, body: c.bodyMd.slice(0, 280), author: authors.get(c.authorId) ?? null, createdAt: c.createdAt.toISOString() })),
        alerts: assigned.map((a) => ({ id: a.id, envelopeId: a.envelopeId, envelopeName: names.get(a.envelopeId) ?? "", severity: a.severity, openedAt: a.openedAt.toISOString() })),
        unmatched,
        canMap,
        drafts,
        alertsOnMyBudgets,
        closures,
        failedRuns: failed.map((f) => ({ sourceId: f.sourceId, sourceName: f.sourceName, at: f.at, error: f.error })),
      },
      sent,
      scopes,
      recents: activity.filter((x) => described.has(x.entityId)).slice(0, RECENTS).map((x) => ({ entityType: x.entityType, entityId: x.entityId, title: described.get(x.entityId)?.title ?? "", parent: described.get(x.entityId)?.parent ?? null, action: x.action, at: x.at })),
      pinnedViews: views.map((v) => ({ id: v.id, name: v.name, screen: v.screen, definition: v.definition as Record<string, unknown> })),
      workspace: { name: ws.name, currency: ws.reportingCurrency, period: { start: period.start, end: period.end, elapsed: ratio(elapsedFraction(period, today).toString()) } },
      asOf: { ...asOf, elapsed: ratio(elapsedFraction(period, elapsedDay(today, opts)).toString()) },
      totals,
      setup,
    };
  });
}

/**
 * Open alerts on budgets that are the caller's (HO-005): assigned to them, on a budget they own or
 * one under it, or inside a Budget owner role's scope (a workspace-wide Budget owner owns every
 * budget). One group per top-level budget, with the count per rule; assigned first, then the most
 * severe and the largest.
 */
async function myAlertGroups(tx: Tx, auth: AuthContext, alerts: readonly OpenAlert[], lineage: Map<string, LineageStep[]>): Promise<NonNullable<HomeResponse["waitingOnMe"]["alertsOnMyBudgets"]>> {
  const me = auth.user.id;
  const owners = auth.assignments.filter((a) => a.role === "BUDGET_OWNER");
  const ownsAll = owners.some((a) => !("children" in a.scope) || a.scope.children.length === 0);
  const scoped = owners.length > 0 && !ownsAll ? await envelopeScopeTargets(tx, [...new Set(alerts.map((a) => a.envelopeId))]) : null;
  const mine = alerts.filter(
    (a) => a.ownerId === me || ownsAll || (lineage.get(a.envelopeId) ?? []).some((s) => s.ownerId === me) || (scoped !== null && owners.some((o) => matchesScope(o.scope, scoped.get(a.envelopeId) ?? { dims: {} }))),
  );
  if (mine.length === 0) return [];
  const ruleNames = new Map((await tx.pacingRule.findMany({ where: { id: { in: [...new Set(mine.map((a) => a.ruleId))] } }, select: { id: true, name: true } })).map((r) => [r.id, r.name]));
  const worse = (a: string, b: string) => ((SEVERITY_RANK[a] ?? 9) <= (SEVERITY_RANK[b] ?? 9) ? a : b);
  const groups = new Map<string, { envelopeId: string; name: string; severity: string; count: number; assigned: number; rules: Map<string, { ruleId: string; ruleName: string | null; severity: string; count: number }> }>();
  for (const a of mine) {
    const chain = lineage.get(a.envelopeId) ?? [];
    const root = chain[chain.length - 1] ?? { id: a.envelopeId, name: "" };
    const g = groups.get(root.id) ?? { envelopeId: root.id, name: root.name, severity: a.severity, count: 0, assigned: 0, rules: new Map() };
    g.count += 1;
    if (a.ownerId === me) g.assigned += 1;
    g.severity = worse(a.severity, g.severity);
    const r = g.rules.get(a.ruleId) ?? { ruleId: a.ruleId, ruleName: ruleNames.get(a.ruleId) ?? null, severity: a.severity, count: 0 };
    r.count += 1;
    r.severity = worse(a.severity, r.severity);
    g.rules.set(a.ruleId, r);
    groups.set(root.id, g);
  }
  const bySeverity = (x: { severity: string; count: number }, y: { severity: string; count: number }) => (SEVERITY_RANK[x.severity] ?? 9) - (SEVERITY_RANK[y.severity] ?? 9) || y.count - x.count;
  return [...groups.values()]
    .sort((x, y) => y.assigned - x.assigned || bySeverity(x, y) || x.name.localeCompare(y.name))
    .slice(0, 6)
    .map((g) => ({ envelopeId: g.envelopeId, name: g.name, severity: g.severity, count: g.count, assigned: g.assigned, rules: [...g.rules.values()].sort(bySeverity) }));
}
