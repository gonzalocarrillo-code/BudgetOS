import { SlackSettings } from "@budget/domain";

/** Where the web app and the API are reached from outside (deep links, the URLs Slack calls), and a workspace's Slack settings. */
export const appUrl = () => (process.env["APP_BASE_URL"] ?? "http://localhost:5173").replace(/\/$/, "");
export const apiUrl = () => (process.env["API_PUBLIC_URL"] ?? process.env["APP_BASE_URL"] ?? "http://localhost:3000").replace(/\/$/, "");

/** `workspace.settings.slack`, with its defaults. */
export const slackSettingsOf = (raw: unknown) => SlackSettings.parse(((raw ?? {}) as { slack?: unknown }).slack ?? {});
