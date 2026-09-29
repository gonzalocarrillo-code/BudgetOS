import { DomainError, SLACK_ACTIONS, SlackActionValue, type SlackActionId } from "@budget/domain";
import type { PrismaClient } from "@prisma/client";
import { decide } from "../approvals/commands/decide.js";
import { updateAlert } from "../pacing/rules.js";
import { slackAuth, type SlackDeps } from "./identity.js";
import { slackApi } from "./slack-api.js";
import { messageModal, rejectForm } from "./views.js";

/**
 * Buttons and forms (POST /slack/interactions, ADR-046): each runs the app's command as the Slack
 * user's account. The message itself is edited by the notify worker when the change's event arrives.
 */

interface InteractionPayload {
  type: string;
  team: { id: string };
  user: { id: string };
  trigger_id?: string;
  actions?: Array<{ action_id: string; value?: string }>;
  view?: { callback_id?: string; private_metadata?: string; state?: { values?: Record<string, Record<string, { value?: string | null }>> } };
}

/** Slack posts `payload=<json>` (form-encoded); the fields used here are checked, the rest ignored. */
function parseInteraction(raw: unknown): InteractionPayload {
  const body = raw as { payload?: unknown } | null;
  if (typeof body?.payload !== "string") throw new DomainError("VALIDATION", "Missing Slack payload");
  const p = JSON.parse(body.payload) as { type?: unknown; team?: { id?: unknown }; user?: { id?: unknown } };
  if (typeof p.type !== "string" || typeof p.team?.id !== "string" || typeof p.user?.id !== "string") throw new DomainError("VALIDATION", "Unexpected Slack payload");
  return p as InteractionPayload;
}

/** One button click or form submission. Returns the HTTP body Slack expects. */
export async function handleInteraction(prisma: PrismaClient, deps: SlackDeps, raw: unknown): Promise<Record<string, unknown>> {
  const p = parseInteraction(raw);
  const api = slackApi();
  if (p.type === "view_submission" && p.view?.callback_id === "approval.reject") {
    const value = SlackActionValue.parse(JSON.parse(p.view.private_metadata ?? "{}"));
    const reason = p.view.state?.values?.["reason"]?.["reason"]?.value?.trim() ?? "";
    try {
      const auth = await slackAuth(prisma, deps, value.ws, p.team.id, p.user.id);
      await decide(prisma, auth, value.id, { decision: "reject", comment: reason, channel: "slack" });
      return {};
    } catch (e) {
      return { response_action: "errors", errors: { reason: e instanceof Error ? e.message : String(e) } };
    }
  }
  if (p.type !== "block_actions") return {};
  const action = p.actions?.[0];
  if (!action || !(SLACK_ACTIONS as readonly string[]).includes(action.action_id)) return {}; // a link button: Slack opens it
  const id = action.action_id as SlackActionId;
  const value = SlackActionValue.parse(JSON.parse(action.value ?? "{}"));
  try {
    const auth = await slackAuth(prisma, deps, value.ws, p.team.id, p.user.id);
    if (id === "approval.reject") {
      if (api && p.trigger_id) await api.openView(p.trigger_id, rejectForm(value));
      return {};
    }
    if (id === "approval.approve") await decide(prisma, auth, value.id, { decision: "approve", channel: "slack" });
    else if (id === "alert.acknowledge") await updateAlert(prisma, auth, value.id, { status: "ACKNOWLEDGED" });
    else if (id === "alert.snooze") await updateAlert(prisma, auth, value.id, { status: "SNOOZED", snoozedUntil: new Date(Date.now() + 7 * 86_400_000).toISOString() });
    else if (id === "alert.resolve") await updateAlert(prisma, auth, value.id, { status: "RESOLVED" });
    // The message itself is edited by the notify worker when the change's event arrives.
    return {};
  } catch (e) {
    // Tell the person why, privately (a small form they close); nothing changed.
    if (api && p.trigger_id) await api.openView(p.trigger_id, messageModal("Budget OS", `:no_entry: ${e instanceof Error ? e.message : String(e)}`)).catch(() => undefined);
    return {};
  }
}
