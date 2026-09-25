import { DomainError, newId, type Action } from "@budget/domain";
import { audit, bumpDataVersion, lockTarget, outbox, type LockedTargetRow, type TenantContext, type Tx } from "@budget/db";
import { Decimal } from "decimal.js";
import type { TargetVersion } from "@prisma/client";
import { assertInScope } from "../../../common/scope.guard.js";
import type { AuthContext } from "../../../common/tenant.js";
import { targetScope } from "../scope.js";

export { targetScope } from "../scope.js";

/** Shared steps of every target write (spec §10, mirrors envelopes' version-writer). */


export async function lockTargetForWrite(tx: Tx, auth: AuthContext, targetId: string, action: Action): Promise<LockedTargetRow> {
  const t = await lockTarget(tx, targetId);
  if (t === null) throw new DomainError("NOT_FOUND", "Target not found");
  if (t.status !== "active") throw new DomainError("CONFLICT", `Target is ${t.status}`);
  assertInScope(auth, action, await targetScope(tx, t));
  return t;
}

export const targetHead = (t: { draftVersionId: string | null; currentVersionId: string | null }): string | null => t.draftVersionId ?? t.currentVersionId;

/** The org's active metric, or 422. metric_definition is org-level and readable within the org. */
export async function activeMetric(tx: Tx, orgId: string, key: string) {
  const m = await tx.metricDefinition.findUnique({ where: { orgId_key: { orgId, key } } });
  if (m === null || !m.isActive) throw new DomainError("VALIDATION", `Unknown metric ${key}`, { metricKey: key });
  return m;
}

/** Currency targets are in the workspace reporting currency: the planner compares them with KPIs over reporting-currency facts. */
export async function targetCurrency(tx: Tx, workspaceId: string, format: string): Promise<string | null> {
  if (format !== "currency") return null;
  const ws = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { reportingCurrency: true } });
  return ws.reportingCurrency;
}

export interface TargetValueSpec {
  value: string;
  comparator: string;
  valueUpper?: string | undefined;
  rationale?: string | undefined;
}

export function checkValue(spec: TargetValueSpec): void {
  if (spec.valueUpper !== undefined && new Decimal(spec.valueUpper).lt(spec.value)) {
    throw new DomainError("VALIDATION", "valueUpper is below value", { value: spec.value, valueUpper: spec.valueUpper });
  }
}

/** Inserts a DRAFT version and points the target at it; the previous open draft is superseded, never deleted. */
export async function writeTargetDraft(tx: Tx, auth: AuthContext, t: { id: string; draftVersionId: string | null }, spec: TargetValueSpec & { currency: string | null }): Promise<TargetVersion> {
  checkValue(spec);
  const last = await tx.targetVersion.aggregate({ where: { targetId: t.id }, _max: { versionNo: true } });
  const version = await tx.targetVersion.create({
    data: {
      id: newId(),
      targetId: t.id,
      versionNo: (last._max.versionNo ?? 0) + 1,
      value: spec.value,
      comparator: spec.comparator,
      valueUpper: spec.valueUpper ?? null,
      currency: spec.currency,
      rationale: spec.rationale ?? null,
      source: "manual",
      status: "DRAFT",
      createdBy: auth.user.id,
    },
  });
  if (t.draftVersionId) await tx.targetVersion.update({ where: { id: t.draftVersionId }, data: { status: "SUPERSEDED" } });
  await tx.target.update({ where: { id: t.id }, data: { draftVersionId: version.id } });
  return version;
}

/** Exactly one audit_event and one outbox row (`target.changed`) per target write, plus the cache data version. */
export async function recordTargetChange(
  tx: Tx,
  ctx: Pick<TenantContext, "userId" | "actorType" | "requestId">,
  args: { workspaceId: string; targetId: string; action: string; kind: string; before?: unknown; after: Record<string, unknown>; reason?: string | undefined },
): Promise<void> {
  await audit(tx, {
    workspaceId: args.workspaceId,
    actorId: ctx.userId,
    actorType: ctx.actorType,
    action: args.action,
    entityType: "target",
    entityId: args.targetId,
    before: args.before ?? null,
    after: args.after,
    ...(args.reason ? { reason: args.reason } : {}),
    requestId: ctx.requestId,
  });
  await outbox(tx, { workspaceId: args.workspaceId, topic: "target.changed", payload: { targetId: args.targetId, kind: args.kind, ...args.after } });
  await bumpDataVersion(tx, args.workspaceId);
}


export { versionView } from "../views.js";
