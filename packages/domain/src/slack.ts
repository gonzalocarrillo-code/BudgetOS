import { z } from "zod";

/**
 * Slack (product feedback 2026-09-28): where a workspace's notifications go, and the bot's
 * interactive buttons and /budget command. The bot token and signing secret are environment
 * secrets (Secret Manager), never stored here.
 */

const Channel = z
  .string()
  .trim()
  .regex(/^[#@]?[A-Za-z0-9._-]{1,80}$/, "a channel name like #budget-alerts, or a channel id");

export const SlackSeverity = z.enum(["info", "warning", "critical", "data"]);

/** workspace.settings.slack */
export const SlackSettings = z.object({
  /** The Slack team this workspace answers (buttons and /budget from other teams are refused). */
  teamId: z.string().regex(/^T[A-Z0-9]{2,20}$/).optional(),
  teamName: z.string().max(200).optional(),
  /** Approval requests and outcomes; critical alerts whose rule names no channel. */
  defaultChannel: Channel.optional(),
  /** Alerts whose rule names no channel go here (else only critical ones, to the default channel). */
  alertChannel: Channel.optional(),
  /** Which severities post when the rule names no channel. */
  alertSeverities: z.array(SlackSeverity).max(4).default(["critical"]),
  /** Approval requests post with Approve / Reject buttons. */
  approvals: z.boolean().default(true),
  /** Direct messages: a request's approvers when it waits on them, its requester on the outcome (S-004). */
  dms: z.boolean().default(true),
});
export type SlackSettings = z.infer<typeof SlackSettings>;

/** PATCH /workspaces/:ws/integrations/slack. `null` clears a field. */
export const UpdateSlackSettingsInput = z
  .object({
    defaultChannel: Channel.nullable().optional(),
    alertChannel: Channel.nullable().optional(),
    alertSeverities: z.array(SlackSeverity).max(4).optional(),
    approvals: z.boolean().optional(),
    dms: z.boolean().optional(),
    /** Link this workspace to the bot's Slack team (read with auth.test). */
    link: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");
export type UpdateSlackSettingsInput = z.infer<typeof UpdateSlackSettingsInput>;

/** POST /workspaces/:ws/integrations/slack/test */
export const SlackTestInput = z.object({ channel: Channel.optional() });

/** A button's `value`: the workspace and entity it acts on. */
export const SlackActionValue = z.object({ ws: z.string().uuid(), id: z.string().uuid() });
export type SlackActionValue = z.infer<typeof SlackActionValue>;

export const SLACK_ACTIONS = ["alert.acknowledge", "alert.snooze", "alert.resolve", "approval.approve", "approval.reject"] as const;
export type SlackActionId = (typeof SLACK_ACTIONS)[number];
