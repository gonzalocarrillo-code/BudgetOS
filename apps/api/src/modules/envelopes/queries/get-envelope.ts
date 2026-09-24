import { DomainError } from "@budget/domain";
import { withTenant, type Tx } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseId } from "../../../common/parse-input.js";
import { assertInScope, envelopeScopeTarget } from "../../../common/scope.guard.js";
import { parseAsOf } from "./timeline.js";
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
    const atInstant =
      asOf === null
        ? null
        : await tx.envelopeVersion.findFirst({
            where: { envelopeId: id, amountType: "BUDGET", status: { in: ["APPROVED", "SUPERSEDED"] }, approvedAt: { lte: asOf } },
            orderBy: { approvedAt: "desc" },
            include: { phasing: { orderBy: { month: "asc" } } },
          });
    return {
      id: env.id,
      workspaceId: env.workspaceId,
      parentId: env.parentId,
      name: env.name,
      dimensionValues: env.dimensionValues,
      periodId: env.periodId,
      startDate: env.startDate.toISOString().slice(0, 10),
      endDate: env.endDate.toISOString().slice(0, 10),
      currency: env.currency,
      status: env.status,
      ownerId: env.ownerId,
      allowOverAllocation: env.allowOverAllocation,
      rowVersion: env.rowVersion,
      currentVersionId: env.currentVersionId,
      draftVersionId: env.draftVersionId,
      current: current ? versionDto(current) : null,
      draft: draft ? versionDto(draft) : null,
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
    return versions.map(versionDto);
  });
}
