import { DomainError, SLACK_ACTIONS, SlackActionValue, shortRequestId, type SlackActionId } from "@budget/domain";
import type { PrismaClient } from "@prisma/client";
import { authorize } from "../../common/auth/authenticate.js";
import type { RoutePermission } from "../../common/permission.decorator.js";
import type { AuthContext } from "../../common/tenant.js";
import { decide } from "../approvals/commands/decide.js";
import { updateAlert } from "../pacing/rules.js";
import { slackAuth, type SlackDeps } from "./identity.js";
import { slackResponder } from "./respond.js";
import { slackApi } from "./slack-api.js";
import { approvalsReply } from "./slash/approvals.js";
import { changesForm, messageModal, rejectForm } from "./views.js";

/**
 * Buttons and forms (POST /slack/interactions, ADR-046). Each runs the app's command as the Slack
 * user's account, after the permission of the app route that does the same thing (S-001: Slack
 * refuses exactly what the app refuses). The message itself is edited by the notify worker when the
 * change's event arrives. A button on a private message (the /budget approvals list) also replaces
 * that message through the interaction's response_url, which the notify worker cannot edit (S-006).
 */

interface InteractionPayload {
  type: string;
  team: { id: string };
  user: { id: string };
  trigger_id?: string;
  response_url?: string;
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

/** A form opened from a private message carries its response_url, to replace that message on submit. */
const withReply = (c: Clicked): SlackActionValue => (c.value.o && c.payload.response_url ? { ...c.value, r: c.payload.response_url } : c.value);

/** What the private message says after an action: the notice leads the list as it is now. */
const DONE: Partial<Record<SlackActionId, string>> = { "approval.approve": ":white_check_mark: Approved", "approval.reject": ":no_entry: Rejected", "approval.changes": ":leftwards_arrow_with_hook: Changes requested" };

/**
 * Every action button, with the permission of its app route (PATCH /alerts/:id, POST
 * /approvals/:id/decisions). `done: false` opens a form; the form's submission finishes the action.
 */
const ACTIONS: Record<SlackActionId, { permission: RoutePermission; done?: false; run: (c: Clicked) => Promise<void> }> = {
  "approval.approve": { permission: "approval.decide", run: async (c) => void (await decide(c.prisma, c.auth, c.value.id, { decision: "approve", channel: "slack" })) },
  "approval.reject": { permission: "approval.decide", done: false, run: async (c) => openView(c.payload, rejectForm(withReply(c))) },
  "approval.changes": { permission: "approval.decide", done: false, run: async (c) => openView(c.payload, changesForm(withReply(c))) },
  "alert.acknowledge": { permission: "envelope.edit_draft", run: async (c) => void (await updateAlert(c.prisma, c.auth, c.value.id, { status: "ACKNOWLEDGED" })) },
  "alert.snooze": { permission: "envelope.edit_draft", run: async (c) => void (await updateAlert(c.prisma, c.auth, c.value.id, { status: "SNOOZED", snoozedUntil: snoozeUntil() })) },
  "alert.resolve": { permission: "envelope.edit_draft", run: async (c) => void (await updateAlert(c.prisma, c.auth, c.value.id, { status: "RESOLVED" })) },
};

/** Every form (view_submission, by callback_id): the field its errors show under, its permission, and the action it finishes. */
const FORMS: Record<string, { permission: RoutePermission; field: string; action: SlackActionId; submit: (c: Clicked, fields: (block: string) => string) => Promise<void> }> = {
  "approval.reject": { permission: "approval.decide", field: "reason", action: "approval.reject", submit: async (c, fields) => void (await decide(c.prisma, c.auth, c.value.id, { decision: "reject", comment: fields("reason"), channel: "slack" })) },
  "approval.changes": { permission: "approval.decide", field: "comment", action: "approval.changes", submit: async (c, fields) => void (await decide(c.prisma, c.auth, c.value.id, { decision: "request_changes", comment: fields("comment"), channel: "slack" })) },
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

/**
 * Replaces the private message an action came from with what it shows now, led by what happened.
 * False when Slack refused (the response_url expired after 30 minutes or 5 uses): the action stands;
 * the person is told to ask again.
 */
async function replaceOrigin(prisma: PrismaClient, auth: AuthContext, value: SlackActionValue, responseUrl: string | undefined, action: SlackActionId): Promise<boolean> {
  if (!value.o || !responseUrl) return true;
  const notice = `${DONE[action] ?? "Done"} · ${shortRequestId(value.id)}`;
  const body = value.o === "list" ? await approvalsReply(prisma, auth, value.ws, { notice }) : null;
  if (body === null) return true;
  try {
    await slackResponder().respond(responseUrl, { replace_original: true, ...body });
    return true;
  } catch {
    return false;
  }
}

const NOT_REFRESHED = "Done. This list could not be updated: type `/budget approvals` for the list as it is now.";

/** What to tell the person: the command's message, or, when the input was refused, its first problem ("Comment required…"). */
export function messageOf(e: unknown): string {
  if (e instanceof DomainError && e.code === "VALIDATION") {
    const issues = e.details?.["issues"] as { formErrors?: string[]; fieldErrors?: Record<string, string[] | undefined> } | undefined;
    const first = issues?.formErrors?.[0] ?? Object.values(issues?.fieldErrors ?? {}).flat()[0];
    if (first) return first;
  }
  return e instanceof Error ? e.message : String(e);
}

/** One button click or form submission. Returns the HTTP body Slack expects. */
export async function handleInteraction(prisma: PrismaClient, deps: SlackDeps, raw: unknown): Promise<Record<string, unknown>> {
  const p = parseInteraction(raw);
  if (p.type === "view_submission") {
    const form = FORMS[p.view?.callback_id ?? ""];
    if (!form) return {};
    const value = SlackActionValue.parse(JSON.parse(p.view?.private_metadata ?? "{}"));
    const fields = (block: string) => p.view?.state?.values?.[block]?.[block]?.value?.trim() ?? "";
    let auth: AuthContext;
    try {
      auth = await slackAuth(prisma, deps, value.ws, p.team.id, p.user.id);
      authorize(auth, form.permission);
      await form.submit({ prisma, auth, value, payload: p }, fields);
    } catch (e) {
      return { response_action: "errors", errors: { [form.field]: messageOf(e) } };
    }
    return (await replaceOrigin(prisma, auth, value, value.r, form.action)) ? {} : { response_action: "update", view: messageModal("BudgetOS", NOT_REFRESHED) };
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
    if (def.done !== false && !(await replaceOrigin(prisma, auth, value, p.response_url, action.action_id as SlackActionId))) await openView(p, messageModal("BudgetOS", NOT_REFRESHED));
    return {};
  } catch (e) {
    // Tell the person why, privately (a small form they close); nothing changed.
    await openView(p, messageModal("BudgetOS", `:no_entry: ${messageOf(e)}`)).catch(() => undefined);
    return {};
  }
}
