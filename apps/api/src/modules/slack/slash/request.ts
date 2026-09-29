import { DomainError, parseSlackAmount, shortRequestId } from "@budget/domain";
import { envelopePaths, withTenant } from "@budget/db";
import { money } from "@budget/workers";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { authorize } from "../../../common/auth/authenticate.js";
import type { AuthContext } from "../../../common/tenant.js";
import { submitDraft } from "../../envelopes/commands/submit-draft.js";
import { getEnvelope } from "../../envelopes/queries/get-envelope.js";
import { whichBudget } from "../blocks/budget.js";
import { slackApi } from "../slack-api.js";
import { messageModal, reply, requestForm } from "../views.js";
import { findBudget } from "./budgets.js";

/**
 * Sending a budget change for approval from Slack (S-011): /budget request <name>, or a card's
 * "Request a change", opens a form; submitting it runs submitDraft, the app's draft and submit in
 * one transaction, after the same route permissions (PATCH /envelopes/:id/draft, POST …/submit).
 */

/** The request form for a budget, or why it cannot take a change now. */
export async function requestFormFor(prisma: PrismaClient, auth: AuthContext, workspaceId: string, envelopeId: string): Promise<Record<string, unknown>> {
  authorize(auth, "envelope.edit_draft"); // PATCH /envelopes/:id/draft
  authorize(auth, "envelope.submit"); // POST /envelopes/:id/submit
  const env = await getEnvelope(prisma, auth, envelopeId);
  if (env.openRequest) throw new DomainError("CONFLICT", `A request for this budget is already waiting (${shortRequestId(env.openRequest.id)}): \`/budget show ${shortRequestId(env.openRequest.id)}\``);
  if (env.ended) throw new DomainError("CONFLICT", "This budget has ended; reintroduce it in BudgetOS to keep planning");
  if (env.status === "LOCKED") throw new DomainError("LOCKED", "Its period is closed; it must be restated first");
  if (env.status === "ARCHIVED") throw new DomainError("CONFLICT", "This budget is archived");
  const path = await withTenant(prisma, auth.ctx, async (tx) => (await envelopePaths(tx, [envelopeId])).get(envelopeId)?.join(" › ") ?? null);
  const head = env.draft ?? env.current;
  const now = env.current ? `${money(env.current.amount, env.currency)} approved${env.draft && env.draft.status === "DRAFT" ? `, a draft of ${money(env.draft.amount, env.currency)} not sent` : ""}` : "no approved amount yet";
  return requestForm({ ws: workspaceId, id: envelopeId, base: head?.id ?? null }, { title: path ?? env.displayName ?? env.name, now, currency: env.currency });
}

/** /budget request <name>: the form for the budget named; a choice when several match. */
export async function requestReply(prisma: PrismaClient, auth: AuthContext, workspaceId: string, q: string, triggerId: string | undefined, footer: string): Promise<Record<string, unknown>> {
  if (q === "") return reply("Which budget? `/budget request <budget name>`");
  const found = await findBudget(prisma, auth, workspaceId, q);
  if (found.kind === "none") return reply(`Nothing matches “${q}”.${footer}`);
  if (found.kind === "several") return { response_type: "ephemeral", ...whichBudget({ workspaceId, q, hits: found.hits, actionId: "budget.request" }) };
  const view = await requestFormFor(prisma, auth, workspaceId, found.id);
  const api = slackApi();
  if (!api || !triggerId) return reply("Slack gave no way to open the form; use the budget's card instead.");
  await api.openView(triggerId, view);
  return {};
}

const FormState = z.object({ ws: z.string().uuid(), id: z.string().uuid(), base: z.string().uuid().nullable() });

/** The request form, submitted: the new amount through the policy, or the fields' problems. */
export async function submitRequest(prisma: PrismaClient, auth: AuthContext, privateMetadata: string | undefined, fields: (block: string) => string): Promise<Record<string, unknown>> {
  const state = FormState.parse(JSON.parse(privateMetadata ?? "{}"));
  const amount = parseSlackAmount(fields("amount"));
  const why = fields("why");
  const errors: Record<string, string> = {};
  if (amount === null) errors["amount"] = "Type an amount like 120000 or 120,000.50";
  if (why.length < 3) errors["why"] = "Say why, in a few words";
  if (amount === null || why.length < 3) return { response_action: "errors", errors };
  authorize(auth, "envelope.submit"); // POST /envelopes/:id/submit
  const res = await submitDraft(prisma, auth, state.id, { amount, rationale: why, basedOnVersionId: state.base });
  const text = res.autoApproved
    ? `:white_check_mark: *Applied.* ${money(res.amount, res.currency)} is the new budget (${res.policy.name}).`
    : `:outbox_tray: *Sent for approval* as ${shortRequestId(String(res.requestId))} (${res.policy.name}). Its approvers are told in Slack and in BudgetOS.`;
  return { response_action: "update", view: messageModal("BudgetOS", text) };
}
