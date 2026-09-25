import { ChainStep, DomainError, type ScopeTarget } from "@budget/domain";
import { loadBulkChange, type Tx } from "@budget/db";
import { z } from "zod";
import { envelopeScopeTargets } from "../../common/scope.guard.js";
import { targetScope } from "../targets/scope.js";

/** Read-side helpers of the approval engine (spec §9), shared by commands and queries. */

/** The frozen policy copy on a request (spec §7.2). Escalation may insert synthetic steps. */
export const PolicySnapshot = z.object({
  conditions: z.unknown(),
  chain: z.array(ChainStep.extend({ escalatedFrom: z.number().int().optional() })),
  blockSelfApproval: z.boolean(),
  allowExternalEvidence: z.boolean(),
  policyName: z.string().optional(),
});
export type PolicySnapshot = z.infer<typeof PolicySnapshot>;

export const OPEN_STATUSES = ["PENDING", "ESCALATED"] as const;
export const SUPPORTED_ENTITY_TYPES = ["envelope_version", "bulk_change", "target_version"] as const;

export interface RequestTargets {
  /** Envelope versions the request would approve: one for an envelope version, all rows of a bulk change, none for a target. */
  versions: Array<{ id: string; envelopeId: string }>;
  /** Who authored the change (separation of duties). */
  authorId: string;
  /** Dimension scopes an approver must cover: one per envelope, or the target's scope. */
  scopes: ScopeTarget[];
}

/** The versions, author and scopes behind a request (envelope_version, bulk_change or target_version). */
export async function requestTargets(tx: Tx, r: { entityType: string; entityId: string }): Promise<RequestTargets> {
  const scopesOf = async (versions: Array<{ envelopeId: string }>) => [...(await envelopeScopeTargets(tx, [...new Set(versions.map((v) => v.envelopeId))])).values()];
  if (r.entityType === "bulk_change") {
    const bulk = await loadBulkChange(tx, r.entityId);
    if (!bulk) throw new DomainError("NOT_FOUND", "Bulk change not found");
    const versions = await tx.envelopeVersion.findMany({ where: { id: { in: bulk.versionIds } }, select: { id: true, envelopeId: true } });
    return { versions, authorId: bulk.createdBy, scopes: await scopesOf(versions) };
  }
  if (r.entityType === "target_version") {
    const tv = await tx.targetVersion.findUnique({ where: { id: r.entityId }, include: { target: true } });
    if (tv === null) throw new DomainError("NOT_FOUND", "Target version not found");
    return { versions: [], authorId: tv.createdBy, scopes: [await targetScope(tx, tv.target)] };
  }
  const v = await tx.envelopeVersion.findUnique({ where: { id: r.entityId }, select: { id: true, envelopeId: true, createdBy: true } });
  if (v === null) throw new DomainError("NOT_FOUND", "Version not found");
  return { versions: [{ id: v.id, envelopeId: v.envelopeId }], authorId: v.createdBy, scopes: await scopesOf([v]) };
}

