import type { Action } from "@budget/domain";
import { SetMetadata } from "@nestjs/common";

/**
 * What a route requires. Every route must declare one; the tenant interceptor rejects routes that
 * do not (fail closed).
 * - `authenticated`: a verified, active user; no workspace.
 * - `workspace.member`: any role in the resolved workspace.
 * - an `Action`: a role in the workspace that grants it (spec §5.4). Dimension scopes are checked
 *   against the target entity in the service with `assertInScope` (scope.guard.ts).
 */
export type RoutePermission = Action | "workspace.member" | "authenticated";

export const PERMISSION_KEY = "budget:permission";
export const Permission = (permission: RoutePermission) => SetMetadata(PERMISSION_KEY, permission);
