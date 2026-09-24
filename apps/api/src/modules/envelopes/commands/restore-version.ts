import { DomainError, RestoreVersionInput } from "@budget/domain";
import { withTenant } from "@budget/db";
import { Decimal } from "decimal.js";
import type { PrismaClient } from "@prisma/client";
import { parseId, parseInput } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { assertBasedOnHead, assertDraftNotPending, lockForWrite, recordEnvelopeChange, writeDraftVersion } from "./version-writer.js";

/** POST /envelopes/:id/restore/:versionId: a past version's amount and phasing become a new draft; history is untouched. */
export async function restoreVersion(prisma: PrismaClient, auth: AuthContext, rawId: string, rawVersionId: string, raw: unknown) {
  const envelopeId = parseId(rawId);
  const sourceId = parseId(rawVersionId);
  const input = parseInput(RestoreVersionInput, raw ?? {});
  return withTenant(prisma, auth.ctx, async (tx) => {
    const env = await lockForWrite(tx, auth, envelopeId, "envelope.edit_draft");
    assertBasedOnHead(env, input.basedOnVersionId);
    await assertDraftNotPending(tx, env);
    const source = await tx.envelopeVersion.findFirst({ where: { id: sourceId, envelopeId }, include: { phasing: { orderBy: { month: "asc" } } } });
    if (source === null) throw new DomainError("NOT_FOUND", "Version not found on this envelope");
    const version = await writeDraftVersion(tx, auth, env, {
      amount: new Decimal(source.amount.toString()),
      phasing: source.phasing.length ? source.phasing.map((p) => ({ month: p.month.toISOString().slice(0, 10), amount: p.amount.toFixed(2) })) : undefined,
      rationale: input.rationale ?? `Restored from v${source.versionNo}`,
      attachments: source.attachments ?? [],
    });
    await recordEnvelopeChange(tx, auth, {
      workspaceId: env.workspaceId,
      envelopeId,
      action: "envelope.version.restored",
      kind: "draft",
      before: { versionId: env.draftVersionId },
      after: { versionId: version.id, restoredFrom: source.id, restoredFromNo: source.versionNo, amount: version.amount.toFixed(2), versionNo: version.versionNo },
      reason: input.rationale,
    });
    return version;
  });
}
