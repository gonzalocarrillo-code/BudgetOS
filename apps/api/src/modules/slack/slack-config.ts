import { OrgSlackSettings, SlackSettings } from "@budget/domain";

/** Where the web app and the API are reached from outside (deep links, the URLs Slack calls), and a workspace's Slack settings. */
export const appUrl = () => (process.env["APP_BASE_URL"] ?? "http://localhost:5173").replace(/\/$/, "");
export const apiUrl = () => (process.env["API_PUBLIC_URL"] ?? process.env["APP_BASE_URL"] ?? "http://localhost:3000").replace(/\/$/, "");

/** `workspace.settings.slack`, with its defaults. */
export const slackSettingsOf = (raw: unknown) => SlackSettings.parse(((raw ?? {}) as { slack?: unknown }).slack ?? {});

/** `organization.settings.slack` (R11-002): the Slack team the whole org answers to. */
export const orgSlackOf = (raw: unknown) => OrgSlackSettings.parse(((raw ?? {}) as { slack?: unknown }).slack ?? {});

/**
 * The Slack team a workspace answers to: its org's, else (before R11-002) the one it was linked to
 * by hand. Null: not linked.
 */
export const slackTeamOf = (orgSettings: unknown, workspaceSettings: unknown): { id: string; name: string | null } | null => {
  const org = orgSlackOf(orgSettings);
  if (org.teamId) return { id: org.teamId, name: org.teamName ?? null };
  const ws = slackSettingsOf(workspaceSettings);
  return ws.teamId ? { id: ws.teamId, name: ws.teamName ?? null } : null;
};
