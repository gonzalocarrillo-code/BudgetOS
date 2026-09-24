import { DomainError } from "@budget/domain";
import { type Tx } from "@budget/db";
import { Decimal } from "decimal.js";
import type { DiffFacts } from "./policy-matcher.js";

export interface VersionDiff {
  facts: DiffFacts;
  amountBefore: Decimal | null;
  amountAfter: Decimal;
  currency: string;
  envelopeName: string;
}

const DAY_MS = 86_400_000;

/**
 * Diff of a version against the envelope's approved version, in reporting currency (spec §7.2
 * computeDiff). Over-allocation means the approved siblings plus this amount exceed the parent's
 * approved amount, whether or not the parent allows it.
 */
export async function computeDiff(tx: Tx, versionId: string, today: Date = new Date()): Promise<VersionDiff> {
  const v = await tx.envelopeVersion.findUnique({ where: { id: versionId }, include: { envelope: true } });
  if (v === null) throw new DomainError("NOT_FOUND", "Version not found");
  const env = v.envelope;
  const after = new Decimal(v.amountReporting.toString());
  const current = env.currentVersionId ? await tx.envelopeVersion.findUnique({ where: { id: env.currentVersionId } }) : null;
  const before = current ? new Decimal(current.amountReporting.toString()) : null;
  const delta = after.minus(before ?? 0);
  const deltaPct = before === null || before.isZero() ? new Decimal(1) : delta.div(before);

  let isOverAllocation = false;
  if (env.parentId) {
    const parent = await tx.envelope.findUnique({ where: { id: env.parentId } });
    const parentVersion = parent?.currentVersionId ? await tx.envelopeVersion.findUnique({ where: { id: parent.currentVersionId } }) : null;
    if (parentVersion) {
      const siblings = await tx.envelope.findMany({ where: { parentId: env.parentId, id: { not: env.id }, currentVersionId: { not: null } }, select: { currentVersionId: true } });
      const sibVersions = await tx.envelopeVersion.findMany({ where: { id: { in: siblings.map((s) => s.currentVersionId as string) } }, select: { amountReporting: true } });
      const sum = sibVersions.reduce((s, x) => s.plus(x.amountReporting.toString()), new Decimal(0)).plus(after);
      isOverAllocation = sum.gt(parentVersion.amountReporting.toString());
    }
  }

  let level = 0;
  for (let p = env.parentId; p !== null && level < 64; level += 1) {
    const up: { parentId: string | null } | null = await tx.envelope.findUnique({ where: { id: p }, select: { parentId: true } });
    p = up?.parentId ?? null;
  }

  const daysRemaining = Math.max(0, Math.ceil((env.endDate.getTime() - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) / DAY_MS));
  return {
    facts: {
      entityType: "envelope_version",
      amountAbs: after,
      deltaAbs: delta,
      deltaPct,
      isOverAllocation,
      level,
      dimensionValues: env.dimensionValues as Record<string, string>,
      daysRemaining,
    },
    amountBefore: before,
    amountAfter: after,
    currency: env.currency,
    envelopeName: env.name,
  };
}

/**
 * Request summary. Spec §7.2 asks @budget/ai for a model-written summary with this template as the
 * fallback; @budget/ai has no client yet, so the template is what ships (see the T-011 PR).
 */
export function summarizeDiff(d: VersionDiff, rationale: string | null): string {
  const pct = d.facts.deltaPct.mul(100).toDecimalPlaces(1).toFixed(1);
  const before = d.amountBefore === null ? "no approved budget" : d.amountBefore.toFixed(2);
  const flag = d.facts.isOverAllocation ? " — over-allocates the parent" : "";
  const why = rationale ? ` Rationale: ${rationale.slice(0, 280)}` : "";
  return `${d.envelopeName}: ${before} → ${d.amountAfter.toFixed(2)} (reporting, ${d.amountBefore === null ? "new" : `${pct}%`})${flag}.${why}`;
}
