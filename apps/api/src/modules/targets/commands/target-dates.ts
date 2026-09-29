import { DomainError, UpdateTargetDatesInput } from "@budget/domain";
import { withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseId, parseInput } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { targetView } from "../views.js";
import { lockTargetForWrite, recordTargetChange } from "./target-writer.js";

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/**
 * PATCH /targets/:id/dates (ADR-060). A target's dates are the period it covers; its values keep
 * their versions and approvals, so the dates change in place, audited. An envelope's target stays
 * inside the envelope's dates.
 */
export async function updateTargetDates(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const targetId = parseId(rawId);
  const input = parseInput(UpdateTargetDatesInput, raw);
  return withTenant(prisma, auth.ctx, async (tx) => {
    await lockTargetForWrite(tx, auth, targetId, "target.edit_draft");
    const before = await tx.target.findUniqueOrThrow({ where: { id: targetId } });
    const from = { startDate: isoDate(before.startDate), endDate: isoDate(before.endDate) };
    if (from.startDate === input.startDate && from.endDate === input.endDate) throw new DomainError("VALIDATION", "These are already the target's dates");
    if (before.envelopeId !== null) {
      const env = await tx.envelope.findUniqueOrThrow({ where: { id: before.envelopeId }, select: { name: true, startDate: true, endDate: true } });
      const es = isoDate(env.startDate);
      const ee = isoDate(env.endDate);
      if (input.startDate < es || input.endDate > ee) throw new DomainError("VALIDATION", `${env.name} runs ${es} – ${ee}; its target must fall inside`, { startDate: es, endDate: ee });
    }
    const t = await tx.target.update({ where: { id: targetId }, data: { startDate: new Date(`${input.startDate}T00:00:00Z`), endDate: new Date(`${input.endDate}T00:00:00Z`) } });
    await recordTargetChange(tx, auth.ctx, { workspaceId: t.workspaceId, targetId, action: "target.dates_changed", kind: "dates", before: from, after: { startDate: input.startDate, endDate: input.endDate }, reason: input.rationale });
    return targetView(t);
  });
}
