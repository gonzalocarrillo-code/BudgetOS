import { DomainError, UpdatePhasingInput } from "@budget/domain";
import { withTenant } from "@budget/db";
import { Decimal } from "decimal.js";
import type { PrismaClient } from "@prisma/client";
import { parseId, parseInput } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { assertBasedOnHead, assertDraftNotPending, headVersionId, lockForWrite, recordEnvelopeChange, writeDraftVersion } from "./version-writer.js";

/** PATCH /envelopes/:id/phasing: same total as the head version, new monthly split, as a new draft (plan §4.3). */
export async function updatePhasing(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const envelopeId = parseId(rawId);
  const input = parseInput(UpdatePhasingInput, raw);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const env = await lockForWrite(tx, auth, envelopeId, "envelope.edit_draft");
    assertBasedOnHead(env, input.basedOnVersionId);
    await assertDraftNotPending(tx, env);
    const headId = headVersionId(env);
    const head = headId === null ? null : await tx.envelopeVersion.findUnique({ where: { id: headId } });
    if (head === null) throw new DomainError("VALIDATION", "Envelope has no version to phase");
    const version = await writeDraftVersion(tx, auth, env, {
      amount: new Decimal(head.amount.toString()),
      phasing: input.phasing,
      rationale: input.rationale ?? head.rationale ?? undefined,
      attachments: head.attachments ?? [],
    });
    await recordEnvelopeChange(tx, auth, {
      workspaceId: env.workspaceId,
      envelopeId,
      action: "envelope.phasing.changed",
      kind: "draft",
      before: { versionId: head.id },
      after: { versionId: version.id, amount: version.amount.toFixed(2), versionNo: version.versionNo, phasing: input.phasing },
      reason: input.rationale,
    });
    return version;
  });
}
