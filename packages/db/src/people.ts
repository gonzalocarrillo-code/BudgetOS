import type { Tx } from "./sql.js";

/** The caller renames themselves (app_set_my_name: only `name`, only their own row). */
export async function setMyName(tx: Tx, name: string): Promise<string> {
  const [row] = await tx.$queryRaw<Array<{ name: string }>>`SELECT app_set_my_name(${name}::text) AS name`;
  return row?.name ?? name;
}

/** The caller's own Slack settings (app_set_my_slack_settings: only `settings.slack`, only their own row). Returns what was saved. */
export async function setMySlackSettings(tx: Tx, value: Record<string, unknown>): Promise<unknown> {
  const [row] = await tx.$queryRaw<Array<{ saved: unknown }>>`SELECT app_set_my_slack_settings(${JSON.stringify(value)}::jsonb) AS saved`;
  return row?.saved ?? null;
}

/**
 * The caller pins their own app_user.slack_user_id (S-14, app_link_my_slack_user): set only when it
 * was NULL (first contact); otherwise left alone. `conflict` is true when another app_user of the
 * org already holds this Slack user id — the caller's own slack_user_id stays NULL in that case.
 */
export async function linkMySlackUser(tx: Tx, slackUserId: string): Promise<{ slackUserId: string | null; conflict: boolean }> {
  const [row] = await tx.$queryRaw<Array<{ result: { slackUserId: string | null; conflict: boolean } }>>`SELECT app_link_my_slack_user(${slackUserId}::text) AS result`;
  return row?.result ?? { slackUserId: null, conflict: true };
}

/** What a workspace has set up (Home's getting-started steps). */
export async function workspaceSetup(tx: Tx, workspaceId: string): Promise<{ budgets: number; sources: number; people: number; spend: boolean; tags: number }> {
  const [r] = await tx.$queryRaw<Array<{ budgets: bigint; sources: bigint; people: bigint; spend: boolean; tags: bigint }>>`
    SELECT
      (SELECT count(*) FROM envelope WHERE workspace_id = ${workspaceId}::uuid AND status <> 'ARCHIVED') AS budgets,
      (SELECT count(*) FROM data_source WHERE workspace_id = ${workspaceId}::uuid) AS sources,
      (SELECT count(DISTINCT principal_id) FROM role_assignment WHERE workspace_id = ${workspaceId}::uuid) AS people,
      EXISTS (SELECT 1 FROM spend_month WHERE workspace_id = ${workspaceId}::uuid) AS spend,
      (SELECT count(*) FROM tag WHERE workspace_id = ${workspaceId}::uuid) AS tags`;
  return { budgets: Number(r?.budgets ?? 0), sources: Number(r?.sources ?? 0), people: Number(r?.people ?? 0), spend: r?.spend === true, tags: Number(r?.tags ?? 0) };
}
