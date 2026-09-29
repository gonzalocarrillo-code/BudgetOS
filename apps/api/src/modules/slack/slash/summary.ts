import type { HomeResponse } from "@budget/domain";
import type { PrismaClient } from "@prisma/client";
import { authorize } from "../../../common/auth/authenticate.js";
import type { AuthContext } from "../../../common/tenant.js";
import { getHome } from "../../home/home.js";
import { summaryMessage, type SummaryInput } from "../blocks/summary.js";
import { appUrl } from "../slack-config.js";

/** The fields of GET /me/home that /budget shows (S-008), read in one place. */
export function fromHome(home: HomeResponse): Pick<SummaryInput, "workspaceName" | "currency" | "period" | "totals" | "waiting" | "budgets"> {
  return {
    workspaceName: home.workspace?.name ?? null,
    currency: home.workspace?.currency ?? "",
    period: home.workspace?.period ?? null,
    totals: home.totals ?? null,
    waiting: { approvals: home.waitingOnMe.approvals.length, alerts: home.waitingOnMe.alerts.length, mentions: home.waitingOnMe.mentions.length },
    budgets: home.scopes.map((s) => ({ label: s.label, envelopeId: s.envelopeId, budget: s.budget, spentPct: s.spentPct, paceIndex: s.paceIndex })),
  };
}

/** /budget with nothing after it (S-008): the person's summary of the workspace, as Home gives it. */
export async function summaryReply(prisma: PrismaClient, auth: AuthContext, workspaceId: string, footer: string): Promise<Record<string, unknown>> {
  authorize(auth, "workspace.member"); // GET /me/home
  const home = await getHome(prisma, auth);
  return { response_type: "ephemeral", ...summaryMessage({ baseUrl: appUrl(), workspaceId, personName: auth.user.name, footer, ...fromHome(home) }) };
}
