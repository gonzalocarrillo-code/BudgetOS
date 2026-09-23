import { newId, UploadAssetInput, type Role } from "@budget/domain";
import type { TenantContext } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import type { AssetStore } from "../assets/asset-store.js";
import { sanitizeSvg } from "../assets/sanitize-svg.js";
import { assertCanManage, inWorkspace, parseInput, recordChange } from "../context.js";

export async function uploadAsset(
  prisma: PrismaClient,
  ctx: TenantContext,
  roles: Role[],
  raw: unknown,
  store: AssetStore,
): Promise<{ gcsObject: string; icon: string }> {
  assertCanManage(roles);
  const input = parseInput(UploadAssetInput, raw);
  const clean = sanitizeSvg(input.svg);
  const gcsObject = `icons/${newId()}.svg`;
  await store.put(gcsObject, new TextEncoder().encode(clean), input.contentType);
  await inWorkspace(prisma, ctx, async (tx, workspace) => {
    await recordChange(tx, ctx, {
      workspaceId: workspace.id,
      orgId: workspace.orgId,
      action: "registry.asset.uploaded",
      entityType: "asset",
      entityId: newId(),
      kind: "asset.uploaded",
      after: { gcsObject },
    });
  });
  return { gcsObject, icon: `asset:${gcsObject}` };
}
