import { apiUrl } from "./slack-config.js";

/**
 * The Slack app manifest (api.slack.com/apps › Create New App › From a manifest), for the API that
 * Slack calls. One app per environment (docs/runbooks/slack.md). The scopes are exactly what the
 * bot calls; it has no chat:write.public, so it posts only in channels it was invited to.
 */
export const SLACK_BOT_SCOPES = ["chat:write", "commands", "im:write", "users:read", "users:read.email"] as const;

export function slackManifest(apiBase: string = apiUrl()): Record<string, unknown> {
  const base = apiBase.replace(/\/$/, "");
  return {
    display_information: { name: "BudgetOS", description: "Budgets, pacing alerts and approvals from BudgetOS", background_color: "#1f4ed8" },
    features: {
      // Direct messages show in the app's Messages tab; /budget can be typed there too.
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: "BudgetOS", always_online: true },
      slash_commands: [{ command: "/budget", url: `${base}/api/v1/slack/commands`, description: "Budgets, approvals and alerts from BudgetOS", usage_hint: "help | alerts | search <text> | <budget name>", should_escape: false }],
    },
    oauth_config: { scopes: { bot: [...SLACK_BOT_SCOPES] } },
    settings: { interactivity: { is_enabled: true, request_url: `${base}/api/v1/slack/interactions` }, org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
  };
}
