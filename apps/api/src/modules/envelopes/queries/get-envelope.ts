import { DomainError, canInScope } from "@budget/domain";
import { openBulkRequestFor, spendThrough, spendThroughInCurrency, withTenant, type Tx } from "@budget/db";
import { Decimal } from "decimal.js";
import type { PrismaClient } from "@prisma/client";
import { parseId } from "../../../common/parse-input.js";
import { assertInScope, envelopeScopeTarget, envelopeScopeTargets } from "../../../common/scope.guard.js";
import { computeDiff } from "../../approvals/diff.js";
import { matchPolicy, requesterOf } from "../../approvals/policy-matcher.js";
import { parseAsOf } from "./timeline.js";
import { snapshotsByVersion } from "../../baselines/queries/baselines.js";
import type { AuthContext } from "../../../common/tenant.js";

type VersionRow = NonNullable<Awaited<ReturnType<typeof loadVersion>>>;

async function loadVersion(tx: Tx, id: string | null) {
  if (id === null) return null;
  return tx.envelopeVersion.findUnique({ where: { id }, include: { phasing: { orderBy: { month: "asc" } } } });
}

/** Money leaves the API as decimal strings; dates as ISO. */
export function versionDto(v: VersionRow) {
  return {
    id: v.id,
    versionNo: v.versionNo,
    status: v.status,
    amountType: v.amountType,
    amount: v.amount.toFixed(2),
    amountReporting: v.amountReporting.toFixed(2),
    fxRateId: v.fxRateId,
    basedOnVersionId: v.basedOnVersionId,
    rationale: v.rationale,
    attachments: v.attachments,
    createdBy: v.createdBy,
    createdAt: v.createdAt.toISOString(),
    approvedAt: v.approvedAt?.toISOString() ?? null,
    supersededAt: v.supersededAt?.toISOString() ?? null,
    phasing: v.phasing.map((p) => ({ month: p.month.toISOString().slice(0, 10), amount: p.amount.toFixed(2) })),
  };
}

/**
 * The envelope's place in the tree (T-031b, plan 0.6): its parent, its live children and its live
 * siblings, each with its approved amount; the ones outside the caller's scope are left out.
 */
async function structureOf(tx: Tx, auth: AuthContext, env: { id: string; parentId: string | null; workspaceId: string }) {
  const select = { id: true, name: true, status: true, currency: true, currentVersionId: true, dimensionValues: true, endedAt: true } as const;
  const live = { status: { not: "ARCHIVED" as const } };
  const [parent, children, siblings] = await Promise.all([
    env.parentId ? tx.envelope.findUnique({ where: { id: env.parentId }, select }) : null,
    tx.envelope.findMany({ where: { parentId: env.id, ...live }, select, orderBy: { name: "asc" } }),
    tx.envelope.findMany({ where: { workspaceId: env.workspaceId, parentId: env.parentId, id: { not: env.id }, ...live }, select, orderBy: { name: "asc" }, take: 200 }),
  ]);
  const all = [...(parent ? [parent] : []), ...children, ...siblings];
  const versionIds = all.map((e) => e.currentVersionId).filter((v): v is string => v !== null);
  const amounts = new Map((await tx.envelopeVersion.findMany({ where: { id: { in: versionIds } }, select: { id: true, amount: true } })).map((v) => [v.id, v.amount.toFixed(2)]));
  const scopes = await envelopeScopeTargets(tx, all.map((e) => e.id));
  const visible = (id: string) => auth.isOrgAdmin || canInScope(auth.assignments, "envelope.read", scopes.get(id) ?? { dims: {} });
  const node = (e: (typeof all)[number]) => ({ id: e.id, name: e.name, status: e.status, currency: e.currency, dimensionValues: e.dimensionValues as Record<string, string>, approved: e.currentVersionId ? (amounts.get(e.currentVersionId) ?? null) : null, ended: e.endedAt !== null });
  return {
    parent: parent && visible(parent.id) ? node(parent) : null,
    children: children.filter((c) => visible(c.id)).map(node),
    siblings: siblings.filter((c) => visible(c.id)).map(node),
  };
}

/**
 * GET /envelopes/:id[?as_of=]: identity, metadata, the approved version and the open draft. With
 * `as_of`, also the budget approved at that instant: the latest BUDGET version approved by then,
 * whatever it is now (superseded versions keep their approved_at) — the same rule as the planner's
 * `budget` measure (T-012).
 */
export async function getEnvelope(prisma: PrismaClient, auth: AuthContext, rawId: string, rawAsOf?: string) {
  const id = parseId(rawId);
  const asOf = parseAsOf(rawAsOf);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const env = await tx.envelope.findUnique({ where: { id } });
    if (env === null) throw new DomainError("NOT_FOUND", "Envelope not found");
    assertInScope(auth, "envelope.read", await envelopeScopeTarget(tx, id));
    const [current, draft] = await Promise.all([loadVersion(tx, env.currentVersionId), loadVersion(tx, env.draftVersionId)]);
    // The draft's pending approval request, so the drawer can link to it (product feedback 3).
    const versionRequest = env.draftVersionId
      ? await tx.approvalRequest.findFirst({ where: { entityType: "envelope_version", entityId: env.draftVersionId, status: { in: ["PENDING", "ESCALATED", "CHANGES_REQUESTED"] } }, select: { id: true, status: true, summary: true } })
      : null;
    // Or the split / merge / end request that holds the draft (H-011: "Waiting for approval").
    const bulkRequest = versionRequest === null && env.draftVersionId ? await openBulkRequestFor(tx, env.draftVersionId) : null;
    const openRequest = versionRequest ?? (bulkRequest ? { id: bulkRequest.id, status: bulkRequest.status, summary: bulkRequest.summary } : null);
    // Where the open draft would go if this caller sent it now (product feedback 6): a policy
    // with no steps sets it at once ("Apply now"); otherwise, who approves it first.
    const draftPolicy =
      draft && draft.status === "DRAFT" && openRequest === null
        ? await (async () => {
            const policy = await matchPolicy(tx, env.workspaceId, (await computeDiff(tx, draft.id)).facts, requesterOf(auth));
            return policy ? { name: policy.name, autoApprove: policy.chain.length === 0, firstRole: policy.chain[0]?.role ?? null, steps: policy.chain.length } : null;
          })()
        : null;
    const tagIds = (await tx.taggable.findMany({ where: { entityType: "envelope", entityId: id }, select: { tagId: true } })).map((t) => t.tagId);
    const tags = tagIds.length ? await tx.tag.findMany({ where: { id: { in: tagIds } }, select: { id: true, name: true, color: true }, orderBy: { name: "asc" } }) : [];
    const atInstant =
      asOf === null
        ? null
        : await tx.envelopeVersion.findFirst({
            where: { envelopeId: id, amountType: "BUDGET", status: { in: ["APPROVED", "SUPERSEDED"] }, approvedAt: { lte: asOf } },
            orderBy: { approvedAt: "desc" },
            include: { phasing: { orderBy: { month: "asc" } } },
          });
    // H-011 / H-012: when it ended, and the budgets it continues and that continue it.
    const [continues, continuedBy] = await Promise.all([
      tx.envelopeLineage.findFirst({ where: { toEnvelopeId: id, kind: "continues" }, orderBy: { at: "desc" }, select: { fromEnvelopeId: true } }),
      tx.envelopeLineage.findMany({ where: { fromEnvelopeId: id, kind: "continues" }, orderBy: { at: "asc" }, select: { toEnvelopeId: true } }),
    ]);
    const linked = await tx.envelope.findMany({
      where: { id: { in: [...(continues ? [continues.fromEnvelopeId] : []), ...continuedBy.map((c) => c.toEnvelopeId)] } },
      select: { id: true, name: true, status: true, startDate: true, endDate: true, endedAt: true },
    });
    const link = (lid: string) => {
      const e = linked.find((x) => x.id === lid);
      return e ? { id: e.id, name: e.name, status: e.status, startDate: e.startDate.toISOString().slice(0, 10), endDate: e.endDate.toISOString().slice(0, 10), ended: e.endedAt !== null } : null;
    };
    return {
      id: env.id,
      workspaceId: env.workspaceId,
      ended: env.endedAt ? { at: env.endedAt.toISOString(), by: env.endedBy, reason: env.endedReason } : null,
      pendingKind: bulkRequest?.kind ?? null,
      lineage: {
        continues: continues ? link(continues.fromEnvelopeId) : null,
        // Successors whose request was rejected are archived; they are not "continued by".
        continuedBy: continuedBy.map((c) => link(c.toEnvelopeId)).filter((x): x is NonNullable<typeof x> => x !== null && x.status !== "ARCHIVED"),
      },
      parentId: env.parentId,
      name: env.name,
      displayName: env.displayName,
      nameCustom: env.nameCustom,
      matchKey: env.matchKey,
      dimensionValues: env.dimensionValues,
      periodId: env.periodId,
      startDate: env.startDate.toISOString().slice(0, 10),
      endDate: env.endDate.toISOString().slice(0, 10),
      currency: env.currency,
      status: env.status,
      ownerId: env.ownerId,
      allowOverAllocation: env.allowOverAllocation,
      rowVersion: env.rowVersion,
      tags,
      structure: await structureOf(tx, auth, env),
      currentVersionId: env.currentVersionId,
      draftVersionId: env.draftVersionId,
      current: current ? versionDto(current) : null,
      draft: draft ? versionDto(draft) : null,
      openRequest,
      draftPolicy,
      ...(asOf === null ? {} : { asOf: { at: asOf.toISOString(), approved: atInstant ? versionDto(atInstant) : null } }),
    };
  });
}

/** GET /envelopes/:id/versions: every version, newest first. Nothing is ever deleted. */
export async function listVersions(prisma: PrismaClient, auth: AuthContext, rawId: string) {
  const id = parseId(rawId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    assertInScope(auth, "envelope.read", await envelopeScopeTarget(tx, id));
    const versions = await tx.envelopeVersion.findMany({ where: { envelopeId: id }, orderBy: { versionNo: "desc" }, include: { phasing: { orderBy: { month: "asc" } } } });
    // Phase E: the snapshots each version was saved in (the History tab's markers).
    const saved = await snapshotsByVersion(tx, id);
    return versions.map((v) => ({ ...versionDto(v), snapshots: saved.get(v.id) ?? [] }));
  });
}

/**
 * GET /envelopes/:id/spend?through=YYYY-MM-DD: spend on the budget up to a date, in its own
 * currency. End proposes it as the final amount so the unspent part goes back to the parent (H-011).
 *
 * T-6: converting the reporting-currency total back with *today's* FX rate drifts from the
 * released amount as rates move, because each fact was converted at its own date. So a budget
 * currency equal to the workspace's reporting currency reads `amount_reporting` directly (the same
 * number, no FX at all); otherwise facts already in the budget's currency are exact, and only the
 * remainder (facts in another currency) is converted, each at its own date's rate.
 */
export async function getEnvelopeSpend(prisma: PrismaClient, auth: AuthContext, rawId: string, rawThrough?: string) {
  const id = parseId(rawId);
  if (rawThrough !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(rawThrough)) throw new DomainError("VALIDATION", "through must be a date (YYYY-MM-DD)", { through: rawThrough });
  return withTenant(prisma, auth.ctx, async (tx) => {
    const env = await tx.envelope.findUnique({ where: { id }, select: { currency: true, workspaceId: true } });
    if (env === null) throw new DomainError("NOT_FOUND", "Envelope not found");
    assertInScope(auth, "envelope.read", await envelopeScopeTarget(tx, id));
    const through = rawThrough ?? new Date().toISOString().slice(0, 10);
    const ws = await tx.workspace.findUniqueOrThrow({ where: { id: env.workspaceId }, select: { reportingCurrency: true } });
    const spend =
      env.currency === ws.reportingCurrency
        ? new Decimal(await spendThrough(tx, id, through))
        : await (async () => {
            const { native, convertedRemainder } = await spendThroughInCurrency(tx, id, through, env.currency);
            return new Decimal(native).plus(convertedRemainder);
          })();
    return { through, currency: env.currency, spend: spend.toDecimalPlaces(2).toFixed(2) };
  });
}
