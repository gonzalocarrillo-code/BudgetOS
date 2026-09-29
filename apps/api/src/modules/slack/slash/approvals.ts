import { withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { authorize } from "../../../common/auth/authenticate.js";
import type { AuthContext } from "../../../common/tenant.js";
import { listApprovals } from "../../approvals/queries/approvals.js";
import { approvalsList, type WaitingRequest } from "../blocks/approvals.js";
import { appUrl, slackSettingsOf } from "../slack-config.js";

/** Shown at most; the rest are in the app's inbox. */
const LIST_LIMIT = 10;

/** /budget approvals (S-006): the requests waiting on the caller, as GET /approvals?assignee=me gives them. */
export async function approvalsReply(prisma: PrismaClient, auth: AuthContext, workspaceId: string, opts: { notice?: string | null; footer?: string } = {}): Promise<Record<string, unknown>> {
  authorize(auth, "workspace.member"); // GET /approvals
  const res = await listApprovals(prisma, auth, { assignee: "me", limit: String(LIST_LIMIT) });
  const settings = await withTenant(prisma, auth.ctx, (tx) => tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { settings: true } }));
  const s = slackSettingsOf(settings.settings);
  const list = approvalsList({ baseUrl: appUrl(), workspaceId, rows: res.rows as unknown as WaitingRequest[], more: res.nextCursor !== null, buttons: s.approvals !== false, notice: opts.notice ?? null, ...(opts.footer ? { footer: opts.footer } : {}) });
  return { response_type: "ephemeral", ...list };
}
