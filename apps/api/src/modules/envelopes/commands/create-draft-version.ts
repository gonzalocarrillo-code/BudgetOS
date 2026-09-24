import { CreateDraftVersionInput } from "@budget/domain";
import { withTenant } from "@budget/db";
import { Decimal } from "decimal.js";
import type { PrismaClient } from "@prisma/client";
import { parseId, parseInput } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { assertBasedOnHead, assertDraftNotPending, lockForWrite, recordEnvelopeChange, writeDraftVersion } from "./version-writer.js";

/** PATCH /envelopes/:id/draft (spec §7.1, inline edit). A stale basedOnVersionId is a 409 with currentVersionId. */
export async function createDraftVersion(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const envelopeId = parseId(rawId);
  const input = parseInput(CreateDraftVersionInput, raw);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const env = await lockForWrite(tx, auth, envelopeId, "envelope.edit_draft");
    assertBasedOnHead(env, input.basedOnVersionId);
    await assertDraftNotPending(tx, env);
    const version = await writeDraftVersion(tx, auth, env, {
      amount: new Decimal(input.amount),
      phasing: input.phasing,
      rationale: input.rationale,
      attachments: input.attachments,
    });
    await recordEnvelopeChange(tx, auth, {
      workspaceId: env.workspaceId,
      envelopeId,
      action: "envelope.version.created",
      kind: "draft",
      before: { versionId: env.draftVersionId },
      after: { versionId: version.id, amount: version.amount.toFixed(2), versionNo: version.versionNo },
      reason: input.rationale,
    });
    return version;
  });
}
