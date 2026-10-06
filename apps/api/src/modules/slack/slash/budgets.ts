import { DomainError, QueryRequest, can, canInScope, type FilterGroupT } from "@budget/domain";
import { envelopePaths, withTenant } from "@budget/db";
import { context, type Block } from "@budget/workers";
import type { PrismaClient } from "@prisma/client";
import { authorize } from "../../../common/auth/authenticate.js";
import { headline } from "../../../common/headline.js";
import { envelopeScopeTarget, envelopeScopeTargets } from "../../../common/scope.guard.js";
import type { AuthContext } from "../../../common/tenant.js";
import { getEnvelope } from "../../envelopes/queries/get-envelope.js";
import { listAlerts } from "../../pacing/queries.js";
import { runQuery } from "../../query/queries/run-query.js";
import { search } from "../../search/search.js";
import { demoStatus } from "../../workspaces/workspaces.js";
import { budgetCard, budgetList, whichBudget } from "../blocks/budget.js";
import { appUrl } from "../slack-config.js";
import { reply } from "../views.js";

/**
 * /budget <name> and /budget list (S-009): budgets found by the search index, their numbers from
 * the planner (the same measures as Budgets and Home), after the same route permissions.
 */

type Hit = { id: string; title: string; path: string | null; facets?: Record<string, unknown> | null };

const MEASURES = ["budget", "actual", "projected", "spend_to_date_pct", "pace_index"] as const;

/**
 * HF-1 (audit T-5 follow-up): nothing in Slack said demo budgets had gone quiet once a workspace
 * also had a real one (T-5's default exclusion). One context line on `/budget` and `/budget list`,
 * the same condition as the web banner and GET /demo-data's `hidden`.
 */
async function demoHiddenContext(prisma: PrismaClient, auth: AuthContext): Promise<Block | null> {
  const status = await demoStatus(prisma, auth);
  if (!status.hidden) return null;
  return context(`${status.envelopes} demo budgets hidden — this workspace has real budgets. Manage demo data in Settings › Workspace.`);
}

async function findBudgets(prisma: PrismaClient, auth: AuthContext, q: string, limit: number): Promise<Hit[]> {
  authorize(auth, "workspace.member"); // GET /workspaces/:ws/search
  const res = await search(prisma, auth, { q, types: "envelope", limit: String(limit) });
  const groups = res.groups as Array<{ type: string; hits: Hit[] }>;
  return groups.find((g) => g.type === "envelope")?.hits ?? [];
}

export interface BudgetNumbers {
  budget: string | null;
  actual: string | null;
  spentPct: string | null;
  paceIndex: string | null;
}

/**
 * T-8 (audit): budget/actual/pace for a set of envelope ids, one `id in […]` query through the one
 * query path (the same measures as Budgets and Home), for `/budget search` and `/budget list <text>`
 * instead of the search index's numeric facets — those refresh only on outbox events and were
 * recomputing `% spent` as a float. An id the caller cannot read, or outside the current fiscal
 * year's envelopes, is simply missing from the result.
 */
export async function numbersForIds(prisma: PrismaClient, auth: AuthContext, workspaceId: string, ids: string[]): Promise<Map<string, BudgetNumbers>> {
  if (ids.length === 0) return new Map();
  authorize(auth, "envelope.read"); // POST /workspaces/:ws/query
  const q = QueryRequest.parse({
    workspaceId,
    filter: { logic: "and", children: [{ field: { kind: "attr", key: "id" }, op: "in", value: ids }] },
    period: { kind: "relative", preset: "current_year" },
    measures: [...MEASURES],
    limit: ids.length,
  });
  const res = await runQuery(prisma, auth, q);
  const out = new Map<string, BudgetNumbers>();
  // Ungrouped (no groupBy): every row's envelopeId is set.
  for (const r of res.rows) if (r.envelopeId !== null) out.set(r.envelopeId, { budget: r.measures["budget"] ?? null, actual: r.measures["actual"] ?? null, spentPct: r.measures["spend_to_date_pct"] ?? null, paceIndex: r.measures["pace_index"] ?? null });
  return out;
}

/** The card rows for a set of search hits, in the hits' own (relevance) order. */
async function rowsFor(prisma: PrismaClient, auth: AuthContext, workspaceId: string, hits: Hit[]): Promise<Array<{ id: string; label: string; path: string | null; budget: string | null; spentPct: string | null; paceIndex: string | null }>> {
  const numbers = await numbersForIds(prisma, auth, workspaceId, hits.map((h) => h.id));
  return hits.map((h) => {
    const n = numbers.get(h.id) ?? null;
    return { id: h.id, label: h.title, path: h.path, budget: n?.budget ?? null, spentPct: n?.spentPct ?? null, paceIndex: n?.paceIndex ?? null };
  });
}

/** Live budgets named exactly this (name or display name, any case) that the caller may read, with their paths. */
async function namedExactly(prisma: PrismaClient, auth: AuthContext, workspaceId: string, q: string): Promise<Hit[]> {
  return withTenant(prisma, auth.ctx, async (tx) => {
    const named = await tx.envelope.findMany({ where: { workspaceId, status: { not: "ARCHIVED" }, OR: [{ name: { equals: q, mode: "insensitive" } }, { displayName: { equals: q, mode: "insensitive" } }] }, select: { id: true, name: true, displayName: true }, orderBy: { name: "asc" }, take: 20 });
    const scopes = auth.isOrgAdmin ? null : await envelopeScopeTargets(tx, named.map((e) => e.id));
    const readable = named.filter((e) => scopes === null || canInScope(auth.assignments, "envelope.read", scopes.get(e.id) ?? { dims: {} })).slice(0, 5);
    const paths = await envelopePaths(tx, readable.map((e) => e.id));
    return readable.map((e) => ({ id: e.id, title: e.displayName ?? e.name, path: paths.get(e.id)?.join(" › ") ?? null }));
  });
}

/** The budget a name means: one, several to choose from, or none. A budget named exactly that wins over search. */
export async function findBudget(prisma: PrismaClient, auth: AuthContext, workspaceId: string, q: string): Promise<{ kind: "one"; id: string } | { kind: "several"; hits: Hit[] } | { kind: "none" }> {
  authorize(auth, "envelope.read"); // GET /envelopes/:id
  const exact = await namedExactly(prisma, auth, workspaceId, q);
  if (exact.length === 1 && exact[0]) return { kind: "one", id: exact[0].id };
  if (exact.length > 1) return { kind: "several", hits: exact };
  const hits = await findBudgets(prisma, auth, q, 5);
  if (hits.length === 1 && hits[0]) return { kind: "one", id: hits[0].id };
  return hits.length ? { kind: "several", hits } : { kind: "none" };
}

/** /budget <name>: the budget's card; a choice when several match; "nothing matches" otherwise. */
export async function budgetReply(prisma: PrismaClient, auth: AuthContext, workspaceId: string, q: string, footer: string): Promise<Record<string, unknown>> {
  const found = await findBudget(prisma, auth, workspaceId, q);
  if (found.kind === "none") return reply(`Nothing matches “${q}”.${footer} Try \`/budget search ${q}\` or \`/budget list\`.`);
  if (found.kind === "one") return budgetCardReply(prisma, auth, workspaceId, found.id);
  return { response_type: "ephemeral", ...whichBudget({ workspaceId, q, hits: found.hits }) };
}

/** One budget as a card (S-009), as GET /envelopes/:id and /query read it for the caller. */
export async function budgetCardReply(prisma: PrismaClient, auth: AuthContext, workspaceId: string, envelopeId: string, notice?: string | null): Promise<Record<string, unknown>> {
  authorize(auth, "envelope.read"); // GET /envelopes/:id
  const env = await getEnvelope(prisma, auth, envelopeId);
  // Its row among its siblings, everything under it included: the planner has no filter by id.
  const siblings: FilterGroupT = { logic: "and", children: [env.parentId ? { field: { kind: "attr", key: "parent_id" }, op: "eq", value: env.parentId } : { field: { kind: "attr", key: "parent_id" }, op: "is_empty" }, { field: { kind: "attr", key: "status" }, op: "neq", value: "ARCHIVED" }] };
  const q = QueryRequest.parse({ workspaceId, filter: siblings, period: { kind: "range", start: env.startDate, end: env.endDate }, measures: [...MEASURES], subtree: true, limit: 1000 });
  const [res, alerts, extra] = await Promise.all([
    runQuery(prisma, auth, q).catch((e: unknown) => (e instanceof DomainError && e.code === "FORBIDDEN" ? null : Promise.reject(e))),
    listAlerts(prisma, auth, { envelopeId, status: "OPEN,ACKNOWLEDGED", limit: "3" }) as Promise<Array<{ severity: string; ruleName: string | null; status: string }>>,
    withTenant(prisma, auth.ctx, async (tx) => ({
      path: (await envelopePaths(tx, [envelopeId])).get(envelopeId)?.join(" › ") ?? null,
      owner: env.ownerId ? ((await tx.user.findUnique({ where: { id: env.ownerId }, select: { name: true } }))?.name ?? null) : null,
      reporting: (await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { reportingCurrency: true } })).reportingCurrency,
    })),
  ]);
  const row = res?.rows.find((r) => r.envelopeId === envelopeId);
  // S-011: the Request a change button, for someone who may draft and send a change to it now.
  const requestable = env.status === "APPROVED" && env.ended === null && env.openRequest === null && (await canRequest(prisma, auth, envelopeId));
  const m = row?.measures ?? null;
  const card = budgetCard({
    baseUrl: appUrl(),
    workspaceId,
    envelopeId,
    name: env.displayName ?? env.name,
    path: extra.path,
    status: env.status,
    ended: env.ended !== null,
    period: { start: env.startDate, end: env.endDate },
    reportingCurrency: extra.reporting,
    ownerName: extra.owner,
    numbers: m ? { budget: m["budget"] ?? null, actual: m["actual"] ?? null, projected: m["projected"] ?? null, spentPct: m["spend_to_date_pct"] ?? null, paceIndex: m["pace_index"] ?? null } : null,
    own: env.current && env.currency !== extra.reporting ? { amount: env.current.amount, currency: env.currency } : null,
    openRequest: env.openRequest ? { id: env.openRequest.id, summary: env.openRequest.summary } : null,
    draft: env.draft && env.draft.status === "DRAFT" ? { amount: env.draft.amount, currency: env.currency } : null,
    alerts,
    children: env.structure.children.length,
    notice: notice ?? null,
    canRequest: requestable,
  });
  const demoLine = await demoHiddenContext(prisma, auth);
  if (demoLine) card.blocks.push(demoLine);
  return { response_type: "ephemeral", ...card };
}

/** Whether the caller may draft and send a change to this budget now (the card's button). */
export async function canRequest(prisma: PrismaClient, auth: AuthContext, envelopeId: string): Promise<boolean> {
  if (!can(auth.roles, "envelope.edit_draft") || !can(auth.roles, "envelope.submit")) return false;
  if (auth.isOrgAdmin) return true;
  const target = await withTenant(prisma, auth.ctx, (tx) => envelopeScopeTarget(tx, envelopeId));
  return canInScope(auth.assignments, "envelope.edit_draft", target) && canInScope(auth.assignments, "envelope.submit", target);
}

/** /budget list [text]: the caller's headline budgets this fiscal year (top-level, or their scope), or the budgets matching the text. */
export async function listReply(prisma: PrismaClient, auth: AuthContext, workspaceId: string, text: string, footer: string): Promise<Record<string, unknown>> {
  const reporting = await withTenant(prisma, auth.ctx, async (tx) => (await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { reportingCurrency: true } })).reportingCurrency);
  if (text !== "") {
    const hits = await findBudgets(prisma, auth, text, 10);
    // T-8 (audit): the search index's numeric facets are for ranking only and refresh on a lag; the
    // card's numbers come from the one query path — the same measures as Budgets and Home — by
    // resolving the hit ids first, then one `id in […]` query, same as `/budget <name>`'s card.
    const rows = await rowsFor(prisma, auth, workspaceId, hits);
    const list = budgetList({ baseUrl: appUrl(), workspaceId, title: `Budgets matching “${text}”`, currency: reporting, rows, more: hits.length === 10, footer });
    const demoLine = await demoHiddenContext(prisma, auth);
    if (demoLine) list.blocks.push(demoLine);
    return { response_type: "ephemeral", ...list };
  }
  authorize(auth, "envelope.read"); // POST /workspaces/:ws/query
  const head = headline(auth);
  if (head === undefined) return reply(`No budgets you can read in this workspace.${footer}`);
  const q = QueryRequest.parse({ workspaceId, filter: head.filter, subtree: head.subtree, period: { kind: "relative", preset: "current_year" }, measures: [...MEASURES], sort: [{ key: "budget", dir: "desc" }], limit: 15 });
  const res = await runQuery(prisma, auth, q);
  const rows = res.rows.map((r) => ({ id: r.envelopeId, label: r.path.at(-1) ?? r.key, path: r.path.length > 1 ? r.path.slice(0, -1).join(" › ") : null, budget: r.measures["budget"] ?? null, spentPct: r.measures["spend_to_date_pct"] ?? null, paceIndex: r.measures["pace_index"] ?? null }));
  const list = budgetList({ baseUrl: appUrl(), workspaceId, title: head.basis === "top_level" ? "Top-level budgets, this fiscal year" : "Your budgets, this fiscal year", currency: reporting, rows, more: res.nextCursor !== null, footer });
  const demoLine = await demoHiddenContext(prisma, auth);
  if (demoLine) list.blocks.push(demoLine);
  return { response_type: "ephemeral", ...list };
}
