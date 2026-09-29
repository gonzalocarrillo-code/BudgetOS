import { DomainError, QueryRequest, canInScope, type FilterGroupT } from "@budget/domain";
import { envelopePaths, withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import { authorize } from "../../../common/auth/authenticate.js";
import { headline } from "../../../common/headline.js";
import { envelopeScopeTargets } from "../../../common/scope.guard.js";
import type { AuthContext } from "../../../common/tenant.js";
import { getEnvelope } from "../../envelopes/queries/get-envelope.js";
import { listAlerts } from "../../pacing/queries.js";
import { runQuery } from "../../query/queries/run-query.js";
import { search } from "../../search/search.js";
import { budgetCard, budgetList, whichBudget } from "../blocks/budget.js";
import { appUrl } from "../slack-config.js";
import { reply } from "../views.js";

/**
 * /budget <name> and /budget list (S-009): budgets found by the search index, their numbers from
 * the planner (the same measures as Budgets and Home), after the same route permissions.
 */

type Hit = { id: string; title: string; path: string | null; facets?: Record<string, unknown> | null };

const MEASURES = ["budget", "actual", "projected", "spend_to_date_pct", "pace_index"] as const;

async function findBudgets(prisma: PrismaClient, auth: AuthContext, q: string, limit: number): Promise<Hit[]> {
  authorize(auth, "workspace.member"); // GET /workspaces/:ws/search
  const res = await search(prisma, auth, { q, types: "envelope", limit: String(limit) });
  const groups = res.groups as Array<{ type: string; hits: Hit[] }>;
  return groups.find((g) => g.type === "envelope")?.hits ?? [];
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

/** /budget <name>: the budget's card; a choice when several match; "nothing matches" otherwise. A budget named exactly that wins over search. */
export async function budgetReply(prisma: PrismaClient, auth: AuthContext, workspaceId: string, q: string, footer: string): Promise<Record<string, unknown>> {
  authorize(auth, "envelope.read"); // GET /envelopes/:id
  const exact = await namedExactly(prisma, auth, workspaceId, q);
  if (exact.length === 1 && exact[0]) return budgetCardReply(prisma, auth, workspaceId, exact[0].id);
  if (exact.length > 1) return { response_type: "ephemeral", ...whichBudget({ workspaceId, q, hits: exact }) };
  const hits = await findBudgets(prisma, auth, q, 5);
  if (hits.length === 0) return reply(`Nothing matches “${q}”.${footer} Try \`/budget search ${q}\` or \`/budget list\`.`);
  const one = hits.length === 1 ? hits[0] : undefined;
  if (one) return budgetCardReply(prisma, auth, workspaceId, one.id);
  return { response_type: "ephemeral", ...whichBudget({ workspaceId, q, hits }) };
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
  });
  return { response_type: "ephemeral", ...card };
}

/** /budget list [text]: the caller's headline budgets this fiscal year (top-level, or their scope), or the budgets matching the text. */
export async function listReply(prisma: PrismaClient, auth: AuthContext, workspaceId: string, text: string, footer: string): Promise<Record<string, unknown>> {
  const reporting = await withTenant(prisma, auth.ctx, async (tx) => (await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { reportingCurrency: true } })).reportingCurrency);
  if (text !== "") {
    const hits = await findBudgets(prisma, auth, text, 10);
    const rows = hits.map((h) => {
      const f = h.facets ?? {};
      const budget = typeof f["budget"] === "number" || typeof f["budget"] === "string" ? String(f["budget"]) : null;
      const actual = typeof f["actual"] === "number" || typeof f["actual"] === "string" ? String(f["actual"]) : null;
      const spent = budget && actual && !new Decimal(budget).isZero() ? new Decimal(actual).div(budget).toString() : null;
      return { id: h.id, label: h.title, path: h.path, budget, spentPct: spent, paceIndex: f["pace_index"] === null || f["pace_index"] === undefined ? null : String(f["pace_index"]) };
    });
    return { response_type: "ephemeral", ...budgetList({ baseUrl: appUrl(), workspaceId, title: `Budgets matching “${text}”`, currency: reporting, rows, more: hits.length === 10, footer }) };
  }
  authorize(auth, "envelope.read"); // POST /workspaces/:ws/query
  const head = headline(auth);
  if (head === undefined) return reply(`No budgets you can read in this workspace.${footer}`);
  const q = QueryRequest.parse({ workspaceId, filter: head.filter, subtree: head.subtree, period: { kind: "relative", preset: "current_year" }, measures: [...MEASURES], sort: [{ key: "budget", dir: "desc" }], limit: 15 });
  const res = await runQuery(prisma, auth, q);
  const rows = res.rows.map((r) => ({ id: r.envelopeId, label: r.path.at(-1) ?? r.key, path: r.path.length > 1 ? r.path.slice(0, -1).join(" › ") : null, budget: r.measures["budget"] ?? null, spentPct: r.measures["spend_to_date_pct"] ?? null, paceIndex: r.measures["pace_index"] ?? null }));
  return { response_type: "ephemeral", ...budgetList({ baseUrl: appUrl(), workspaceId, title: head.basis === "top_level" ? "Top-level budgets, this fiscal year" : "Your budgets, this fiscal year", currency: reporting, rows, more: res.nextCursor !== null, footer }) };
}
