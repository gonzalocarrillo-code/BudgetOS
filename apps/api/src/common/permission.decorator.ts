import type { Action } from "@budget/domain";
import { SetMetadata } from "@nestjs/common";

/**
 * What a route requires. Every route must declare one; the tenant interceptor rejects routes that
 * do not (fail closed).
 * - `authenticated`: a verified, active user; no workspace.
 * - `workspace.member`: any role in the resolved workspace.
 * - `org.admin`: an ORG_ADMIN of the caller's org, with or without a workspace (T-040).
 * - an `Action`: a role in the workspace that grants it (spec §5.4). Dimension scopes are checked
 *   against the target entity in the service with `assertInScope` (scope.guard.ts).
 * - `slack.signed`: no JWT; the request carries Slack's signature (SLACK_SIGNING_SECRET). The
 *   handler acts as the Slack user's Budget OS account, with that account's permissions.
 */
export type RoutePermission = Action | "workspace.member" | "authenticated" | "org.admin" | "slack.signed";

export const PERMISSION_KEY = "budget:permission";
export const Permission = (permission: RoutePermission) => SetMetadata(PERMISSION_KEY, permission);

/**
 * ADR-052: a superadmin route that manages a workspace's lifecycle (archive, restore, delete,
 * undelete). It reaches archived and deleted workspaces; every other route is refused on them.
 */
export const LIFECYCLE_KEY = "budget:workspace-lifecycle";
export const WorkspaceLifecycle = () => SetMetadata(LIFECYCLE_KEY, true);
