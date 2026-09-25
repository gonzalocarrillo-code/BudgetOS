import { ListSavedViewsQuery } from "@budget/domain";
import { withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { savedViewView } from "../views.js";

/** GET /workspaces/:ws/saved-views?screen: the caller's own views and the workspace's shared ones, by name. */
export async function listSavedViews(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const q = parseInput(ListSavedViewsQuery, raw ?? {});
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) =>
    (
      await tx.savedView.findMany({
        where: { workspaceId, ...(q.screen ? { screen: q.screen } : {}), OR: [{ createdBy: auth.user.id }, { visibility: "workspace" }] },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      })
    ).map(savedViewView),
  );
}
