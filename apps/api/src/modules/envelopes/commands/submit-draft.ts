import { SubmitDraftInput } from "@budget/domain";
import { withTenant } from "@budget/db";
import { Decimal } from "decimal.js";
import type { PrismaClient } from "@prisma/client";
import { parseId, parseInput } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { submitVersionIn } from "./submit-version.js";
import { assertBasedOnHead, assertDraftNotPending, lockForWrite, recordEnvelopeChange, writeDraftVersion } from "./version-writer.js";

/**
 * A new amount sent for approval in one step (S-011, from Slack's request form): the draft that
 * PATCH /envelopes/:id/draft writes and the submission POST /envelopes/:id/submit makes, in one
 * transaction, with each one's audit and outbox rows. The policy decides as for any change: a
 * request for the approvers, or (an admin's own change, a policy with no steps) applied at once.
 */
export async function submitDraft(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const envelopeId = parseId(rawId);
  const input = parseInput(SubmitDraftInput, raw);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const env = await lockForWrite(tx, auth, envelopeId, "envelope.edit_draft");
    assertBasedOnHead(env, input.basedOnVersionId);
    await assertDraftNotPending(tx, env);
    const version = await writeDraftVersion(tx, auth, env, { amount: new Decimal(input.amount), phasing: undefined, rationale: input.rationale, attachments: [] });
    await recordEnvelopeChange(tx, auth, {
      workspaceId: env.workspaceId,
      envelopeId,
      action: "envelope.version.created",
      kind: "draft",
      before: { versionId: env.draftVersionId },
      after: { versionId: version.id, amount: version.amount.toFixed(2), versionNo: version.versionNo },
      reason: input.rationale,
    });
    const submitted = await submitVersionIn(tx, auth, envelopeId, { versionId: version.id });
    return { ...submitted, amount: version.amount.toFixed(2), currency: env.currency };
  });
}
