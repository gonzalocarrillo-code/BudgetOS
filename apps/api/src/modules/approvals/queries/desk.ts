import { canInScope, readScopeFilter, type Action } from "@budget/domain";
import { loadBulkChange, withTenant, type Tx } from "@budget/db";
import { Decimal } from "decimal.js";
import type { PrismaClient } from "@prisma/client";
import { requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { OPEN_STATUSES, PolicySnapshot, SUPPORTED_ENTITY_TYPES, requestTargets } from "../read.js";

/**
 * Approval requests as Home and the Overview show them (HO-005, HO-010): a readable card per
 * request, the workspace's queue in numbers, and the caller's own requests still waiting. Reads
 * only; the caller's read scope applies as on the inbox's "All open" tab.
 */

export interface RequestCard {
  title: string;
  count: number;
  before: string | null;
  after: string | null;
}

interface RequestRef {
  id: string;
  entityType: string;
  entityId: string;
  summary: string | null;
}

const money = (d: Decimal | null) => (d === null ? null : d.toFixed(2));

/**
 * What each request changes, for people: the budget's name (or a bulk change's rationale), how many
 * budgets, and the approved total before and after in the reporting currency. A new budget has no
 * "before". Targets and batches of results are not money: before and after stay null.
 */
export async function requestCards(tx: Tx, requests: readonly RequestRef[]): Promise<Map<string, RequestCard>> {
  const out = new Map<string, RequestCard>();
  for (const r of requests) {
    const fallback = r.summary ?? r.entityType;
    if (r.entityType === "envelope_version" || r.entityType === "bulk_change") {
      const ids = r.entityType === "bulk_change" ? ((await loadBulkChange(tx, r.entityId))?.versionIds ?? []) : [r.entityId];
      const versions = await tx.envelopeVersion.findMany({ where: { id: { in: ids } }, select: { amountReporting: true, rationale: true, envelope: { select: { name: true, displayName: true, currentVersionId: true } } } });
      const currents = await tx.envelopeVersion.findMany({ where: { id: { in: versions.map((v) => v.envelope.currentVersionId).filter((x): x is string => x !== null) } }, select: { amountReporting: true } });
      const after = versions.reduce((s, v) => s.plus(v.amountReporting.toString()), new Decimal(0));
      const before = currents.length === 0 ? null : currents.reduce((s, v) => s.plus(v.amountReporting.toString()), new Decimal(0));
      const first = versions[0];
      const title = r.entityType === "bulk_change" ? (first?.rationale?.trim() || fallback) : first ? (first.envelope.displayName ?? first.envelope.name) : fallback;
      out.set(r.id, { title, count: versions.length, before: money(before), after: versions.length ? money(after) : null });
    } else if (r.entityType === "target_version") {
      const tv = await tx.targetVersion.findUnique({ where: { id: r.entityId }, select: { target: { select: { metricKey: true, envelopeId: true } } } });
      const env = tv?.target.envelopeId ? await tx.envelope.findUnique({ where: { id: tv.target.envelopeId }, select: { name: true, displayName: true } }) : null;
      out.set(r.id, { title: tv ? `${tv.target.metricKey.toUpperCase()} target${env ? ` · ${env.displayName ?? env.name}` : ""}` : fallback, count: 1, before: null, after: null });
    } else {
      const b = r.entityType === "manual_entry" ? await tx.manualEntryBatch.findUnique({ where: { id: r.entityId }, select: { rows: true } }) : null;
      out.set(r.id, { title: fallback, count: b && Array.isArray(b.rows) ? b.rows.length : 1, before: null, after: null });
    }
  }
  return out;
}

export interface QueueSummary {
  waiting: number;
  overdue: number;
  /** Days the oldest open request has waited; null when none waits. */
  oldestDays: number | null;
  /** Whom the requests wait on: the role of each one's current step. */
  byRole: Array<{ role: string; count: number }>;
  /** What they ask for: budgets, bulk changes, targets, results. */
  byKind: Array<{ kind: string; count: number }>;
}

/** Whether the caller reads every budget and target in the workspace (no per-request scope check needed). */
function readsWorkspace(auth: AuthContext, action: Action): boolean | null {
  if (auth.isOrgAdmin) return true;
  try {
    return readScopeFilter(auth.assignments, action) === null;
  } catch {
    return null; // no role grants the action: nothing is readable
  }
}

/**
 * The workspace's open approval requests (PENDING, ESCALATED) the caller may read, in numbers: how
 * many, how many are overdue, how old the oldest is, whose step they wait on, and what they are.
 */
export async function approvalQueue(prisma: PrismaClient, auth: AuthContext, now: Date = new Date()): Promise<QueueSummary> {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const wide = { envelope: readsWorkspace(auth, "envelope.read"), target: readsWorkspace(auth, "target.read") };
  return withTenant(prisma, auth.ctx, async (tx) => {
    const open = await tx.approvalRequest.findMany({
      where: { workspaceId, status: { in: [...OPEN_STATUSES] }, entityType: { in: [...SUPPORTED_ENTITY_TYPES] } },
      select: { id: true, entityType: true, entityId: true, currentStep: true, policySnapshot: true, requestedAt: true, dueAt: true },
    });
    const readable: typeof open = [];
    for (const r of open) {
      const action = r.entityType === "target_version" ? "target" : "envelope";
      if (wide[action] === true) readable.push(r);
      else if (wide[action] === false) {
        const targets = await requestTargets(tx, r).catch(() => null);
        if (targets && targets.scopes.length > 0 && targets.scopes.every((t) => canInScope(auth.assignments, action === "target" ? "target.read" : "envelope.read", t))) readable.push(r);
      }
    }
    const tally = (keys: string[]) => [...keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>())].map(([k, count]) => ({ k, count })).sort((a, b) => b.count - a.count || a.k.localeCompare(b.k));
    const roleOf = (r: (typeof open)[number]) => {
      const snap = PolicySnapshot.safeParse(r.policySnapshot);
      return snap.success ? (snap.data.chain[r.currentStep]?.role ?? "UNKNOWN") : "UNKNOWN";
    };
    const oldest = readable.reduce<Date | null>((min, r) => (min === null || r.requestedAt < min ? r.requestedAt : min), null);
    return {
      waiting: readable.length,
      overdue: readable.filter((r) => r.dueAt !== null && r.dueAt.getTime() < now.getTime()).length,
      oldestDays: oldest === null ? null : Math.floor((now.getTime() - oldest.getTime()) / 86_400_000),
      byRole: tally(readable.map(roleOf)).map(({ k, count }) => ({ role: k, count })),
      byKind: tally(readable.map((r) => r.entityType)).map(({ k, count }) => ({ kind: k, count })),
    };
  });
}

export interface SentRequest extends RequestCard {
  id: string;
  summary: string | null;
  entityType: string;
  requestedAt: string;
  dueAt: string | null;
  /** The role of the step it waits on. */
  waitingOn: string | null;
}

/** The caller's own open requests, oldest first: what they sent and whom it waits on. */
export async function sentByMe(prisma: PrismaClient, auth: AuthContext, limit = 10): Promise<SentRequest[]> {
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const rows = await tx.approvalRequest.findMany({
      where: { workspaceId, requestedBy: auth.user.id, status: { in: [...OPEN_STATUSES] }, entityType: { in: [...SUPPORTED_ENTITY_TYPES] } },
      orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
      take: limit,
      select: { id: true, entityType: true, entityId: true, summary: true, currentStep: true, policySnapshot: true, requestedAt: true, dueAt: true },
    });
    const cards = await requestCards(tx, rows);
    return rows.map((r) => {
      const snap = PolicySnapshot.safeParse(r.policySnapshot);
      const card = cards.get(r.id) ?? { title: r.summary, count: 1, before: null, after: null };
      return { id: r.id, summary: r.summary, entityType: r.entityType, requestedAt: r.requestedAt.toISOString(), dueAt: r.dueAt?.toISOString() ?? null, waitingOn: snap.success ? (snap.data.chain[r.currentStep]?.role ?? null) : null, ...card };
    });
  });
}
