import type { Target, TargetVersion } from "@prisma/client";

/** Response shapes of targets and their versions, shared by commands and queries (spec §10). */

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export function targetView(t: Target) {
  return {
    id: t.id,
    workspaceId: t.workspaceId,
    scopeType: t.scopeType,
    envelopeId: t.envelopeId,
    scopeFilter: t.scopeFilter,
    metricKey: t.metricKey,
    startDate: isoDate(t.startDate),
    endDate: isoDate(t.endDate),
    ownerId: t.ownerId,
    status: t.status,
    currentVersionId: t.currentVersionId,
    draftVersionId: t.draftVersionId,
  };
}

export function versionView(v: TargetVersion) {
  return {
    id: v.id,
    targetId: v.targetId,
    versionNo: v.versionNo,
    value: v.value.toString(),
    comparator: v.comparator,
    valueUpper: v.valueUpper?.toString() ?? null,
    currency: v.currency,
    rationale: v.rationale,
    source: v.source,
    status: v.status,
    approvalRequestId: v.approvalRequestId,
    createdBy: v.createdBy,
    createdAt: v.createdAt.toISOString(),
    approvedAt: v.approvedAt?.toISOString() ?? null,
  };
}
