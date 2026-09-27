import { ChainStep, DomainError, type ScopeTarget } from "@budget/domain";
import { loadBulkChange, type Tx } from "@budget/db";
import { z } from "zod";
import { envelopeScopeTargets, scopeTargetForValues } from "../../common/scope.guard.js";
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
export const SUPPORTED_ENTITY_TYPES = ["envelope_version", "bulk_change", "target_version", "manual_entry"] as const;

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
  if (r.entityType === "manual_entry") {
    // T-039: an approver must cover every row's tuple (with the batch's channel).
    const b = await tx.manualEntryBatch.findUnique({ where: { id: r.entityId } });
    if (b === null) throw new DomainError("NOT_FOUND", "Manual entry batch not found");
    return { versions: [], authorId: b.createdBy, scopes: await manualEntryScopes(tx, b) };
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


/** The dimension scope of every distinct row tuple of a manual entry batch, with its channel (at least one). */
export async function manualEntryScopes(tx: Tx, b: { workspaceId: string; channel: string; rows: unknown }): Promise<ScopeTarget[]> {
  const rows = (Array.isArray(b.rows) ? b.rows : []) as Array<{ dimensionValues?: Record<string, string> }>;
  const tuples = [...new Map(rows.map((row) => ({ ...(row.dimensionValues ?? {}), channel: b.channel })).map((t) => [JSON.stringify(Object.entries(t).sort()), t])).values()];
  const keys = [...new Set(tuples.flatMap((t) => Object.keys(t))), "channel"];
  const dims = await tx.dimension.findMany({ where: { key: { in: keys }, OR: [{ workspaceId: null }, { workspaceId: b.workspaceId }] }, select: { id: true, key: true, workspaceId: true } });
  const dimOf = new Map<string, string>();
  for (const d of dims) if (!dimOf.has(d.key) || d.workspaceId !== null) dimOf.set(d.key, d.id);
  const codes = [...new Set([...tuples.flatMap((t) => Object.values(t)), b.channel])];
  const values = await tx.dimensionValue.findMany({ where: { dimensionId: { in: [...dimOf.values()] }, code: { in: codes } }, select: { id: true, dimensionId: true, code: true } });
  const valueOf = new Map(values.map((v) => [`${v.dimensionId}|${v.code}`, v.id]));
  const scopes: ScopeTarget[] = [];
  for (const t of tuples.length ? tuples : [{ channel: b.channel }]) {
    const pairs = Object.entries(t).flatMap(([k, code]) => {
      const dimensionId = dimOf.get(k);
      const valueId = dimensionId ? valueOf.get(`${dimensionId}|${code}`) : undefined;
      return dimensionId && valueId ? [{ dimensionId, valueId }] : [];
    });
    scopes.push(await scopeTargetForValues(tx, pairs));
  }
  return scopes;
}
