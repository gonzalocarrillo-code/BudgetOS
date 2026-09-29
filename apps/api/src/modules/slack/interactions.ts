import { DomainError, SLACK_ACTIONS, SlackActionValue, type SlackActionId } from "@budget/domain";
import type { PrismaClient } from "@prisma/client";
import { authorize } from "../../common/auth/authenticate.js";
import type { RoutePermission } from "../../common/permission.decorator.js";
import type { AuthContext } from "../../common/tenant.js";
import { decide } from "../approvals/commands/decide.js";
import { updateAlert } from "../pacing/rules.js";
import { slackAuth, type SlackDeps } from "./identity.js";
import { slackApi } from "./slack-api.js";
import { messageModal, rejectForm } from "./views.js";

/**
 * Buttons and forms (POST /slack/interactions, ADR-046). Each runs the app's command as the Slack
 * user's account, after the permission of the app route that does the same thing (S-001: Slack
 * refuses exactly what the app refuses). The message itself is edited by the notify worker when the
 * change's event arrives.
 */

interface InteractionPayload {
  type: string;
  team: { id: string };
  user: { id: string };
  trigger_id?: string;
  actions?: Array<{ action_id: string; value?: string }>;
  view?: { callback_id?: string; private_metadata?: string; state?: { values?: Record<string, Record<string, { value?: string | null }>> } };
}

interface Clicked {
  prisma: PrismaClient;
  auth: AuthContext;
  value: SlackActionValue;
  payload: InteractionPayload;
}

const snoozeUntil = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

/** Every action button, with the permission of its app route (PATCH /alerts/:id, POST /approvals/:id/decisions). */
const ACTIONS: Record<SlackActionId, { permission: RoutePermission; run: (c: Clicked) => Promise<void> }> = {
  "approval.approve": { permission: "approval.decide", run: async (c) => void (await decide(c.prisma, c.auth, c.value.id, { decision: "approve", channel: "slack" })) },
  "approval.reject": { permission: "approval.decide", run: async (c) => openView(c.payload, rejectForm(c.value)) },
  "alert.acknowledge": { permission: "envelope.edit_draft", run: async (c) => void (await updateAlert(c.prisma, c.auth, c.value.id, { status: "ACKNOWLEDGED" })) },
  "alert.snooze": { permission: "envelope.edit_draft", run: async (c) => void (await updateAlert(c.prisma, c.auth, c.value.id, { status: "SNOOZED", snoozedUntil: snoozeUntil() })) },
  "alert.resolve": { permission: "envelope.edit_draft", run: async (c) => void (await updateAlert(c.prisma, c.auth, c.value.id, { status: "RESOLVED" })) },
};

/** Every form (view_submission, by callback_id): the field its errors show under, and its permission. */
const FORMS: Record<string, { permission: RoutePermission; field: string; submit: (c: Clicked, fields: (block: string) => string) => Promise<void> }> = {
  "approval.reject": { permission: "approval.decide", field: "reason", submit: async (c, fields) => void (await decide(c.prisma, c.auth, c.value.id, { decision: "reject", comment: fields("reason"), channel: "slack" })) },
};

/** Slack posts `payload=<json>` (form-encoded); the fields used here are checked, the rest ignored. */
function parseInteraction(raw: unknown): InteractionPayload {
  const body = raw as { payload?: unknown } | null;
  if (typeof body?.payload !== "string") throw new DomainError("VALIDATION", "Missing Slack payload");
  const p = JSON.parse(body.payload) as { type?: unknown; team?: { id?: unknown }; user?: { id?: unknown } };
  if (typeof p.type !== "string" || typeof p.team?.id !== "string" || typeof p.user?.id !== "string") throw new DomainError("VALIDATION", "Unexpected Slack payload");
  return p as InteractionPayload;
}

async function openView(p: InteractionPayload, view: Record<string, unknown>): Promise<void> {
  const api = slackApi();
  if (api && p.trigger_id) await api.openView(p.trigger_id, view);
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One button click or form submission. Returns the HTTP body Slack expects. */
export async function handleInteraction(prisma: PrismaClient, deps: SlackDeps, raw: unknown): Promise<Record<string, unknown>> {
  const p = parseInteraction(raw);
  if (p.type === "view_submission") {
    const form = FORMS[p.view?.callback_id ?? ""];
    if (!form) return {};
    const value = SlackActionValue.parse(JSON.parse(p.view?.private_metadata ?? "{}"));
    const fields = (block: string) => p.view?.state?.values?.[block]?.[block]?.value?.trim() ?? "";
    try {
      const auth = await slackAuth(prisma, deps, value.ws, p.team.id, p.user.id);
      authorize(auth, form.permission);
      await form.submit({ prisma, auth, value, payload: p }, fields);
      return {};
    } catch (e) {
      return { response_action: "errors", errors: { [form.field]: messageOf(e) } };
    }
  }
  if (p.type !== "block_actions") return {};
  const action = p.actions?.[0];
  if (!action || !(SLACK_ACTIONS as readonly string[]).includes(action.action_id)) return {}; // a link button: Slack opens it
  const def = ACTIONS[action.action_id as SlackActionId];
  const value = SlackActionValue.parse(JSON.parse(action.value ?? "{}"));
  try {
    const auth = await slackAuth(prisma, deps, value.ws, p.team.id, p.user.id);
    authorize(auth, def.permission);
    await def.run({ prisma, auth, value, payload: p });
    return {};
  } catch (e) {
    // Tell the person why, privately (a small form they close); nothing changed.
    await openView(p, messageModal("BudgetOS", `:no_entry: ${messageOf(e)}`)).catch(() => undefined);
    return {};
  }
}
