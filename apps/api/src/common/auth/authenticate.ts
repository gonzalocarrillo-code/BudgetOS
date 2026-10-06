import { DomainError, can, type Role } from "@budget/domain";
import type { RoutePermission } from "../permission.decorator.js";
import type { AuthContext } from "../tenant.js";
import type { AccessRepository } from "./access.repository.js";
import type { JwtVerifier } from "./jwt-verifier.js";
import type { RoleCache, WorkspaceAccess } from "./role-cache.js";

/**
 * The caller's AuthContext (spec §4): verified JWT (`sub`, `email`), an active app user, the
 * workspace (same org), and roles from RoleAssignment (direct and via groups, cached 60 s).
 * Shared by the HTTP interceptor and the MCP server (actor type `mcp`).
 */
export interface AuthDeps {
  verifier: JwtVerifier;
  access: AccessRepository;
  cache: RoleCache;
}

/**
 * How a request may use an archived or deleted workspace (ADR-052): `read` for GETs, `write` for
 * the rest, `lifecycle` for the superadmin routes that archive, restore, delete and undelete it.
 */
export type WorkspaceUse = "read" | "write" | "lifecycle";

export async function authenticate(deps: AuthDeps, input: { authorization: string | undefined; workspaceId: string | null; requestId: string; actorType?: "user" | "mcp"; use?: WorkspaceUse }): Promise<AuthContext> {
  const identity = await deps.verifier.verify(input.authorization);
  const user = await deps.access.findUser(identity);
  if (user === null || !user.isActive) throw new DomainError("FORBIDDEN", "Unknown or inactive user");
  const { workspaceId, requestId } = input;
  let access: WorkspaceAccess | undefined = deps.cache.get(user.id, workspaceId);
  if (!access) {
    access = await deps.access.access(user, workspaceId, requestId);
    deps.cache.set(user.id, workspaceId, access);
  }
  if (workspaceId !== null) {
    const ws = await deps.access.workspaceInfo(workspaceId, user, requestId);
    // Same answer for "no such workspace", "another org's workspace" and a deleted one.
    if (ws === null || ws.orgId !== user.orgId || (ws.deleted && input.use !== "lifecycle")) throw new DomainError("FORBIDDEN", "No access to this workspace");
    if (ws.deleted && !access.isOrgAdmin) throw new DomainError("FORBIDDEN", "No access to this workspace");
    if (ws.status === "ARCHIVED" && input.use !== "lifecycle") {
      // Archived: read-only, and only superadmins still open it.
      if (!access.isOrgAdmin) throw new DomainError("FORBIDDEN", "This workspace is archived", { archived: true });
      if (input.use === "write") throw new DomainError("LOCKED", "This workspace is archived: restore it to make changes", { archived: true });
    }
  }
  const actingAs = workspaceId !== null ? actingAsIn(access) : null;
  return {
    ctx: { workspaceId, orgId: user.orgId, userId: user.id, isOrgAdmin: access.isOrgAdmin && workspaceId === null, actorType: input.actorType ?? "user", requestId, actingAs },
    user: { id: user.id, orgId: user.orgId, email: user.email, name: user.name },
    isOrgAdmin: access.isOrgAdmin,
    roles: [...new Set(access.assignments.map((a) => a.role))] as Role[],
    assignments: access.assignments,
  };
}

/** A superadmin acting in a workspace where they hold no role of their own (ADR-052): their audit rows say so. */
function actingAsIn(access: WorkspaceAccess): "superadmin" | null {
  return access.isOrgAdmin && !access.assignments.some((a) => a.role !== "ORG_ADMIN") ? "superadmin" : null;
}

/**
 * An AuthContext for an email another trusted system vouches for (the Slack user of a linked
 * Slack team, product feedback 2026-09-28): the same user, workspace and role checks as a JWT, and
 * the same superadmin marking. Emails are stored lower-case; a Slack profile's may not be.
 */
export async function authenticateVerifiedEmail(deps: Pick<AuthDeps, "access" | "cache">, input: { email: string; workspaceId: string; requestId: string }): Promise<AuthContext> {
  const email = input.email.trim().toLowerCase();
  const user = await deps.access.findUser({ sub: `external:${email}`, email, emailVerified: true, googleSub: null });
  if (user === null || !user.isActive) throw new DomainError("FORBIDDEN", "No active BudgetOS account for this Slack user's email");
  const ws = await deps.access.workspaceInfo(input.workspaceId, user, input.requestId);
  if (ws === null || ws.orgId !== user.orgId || ws.deleted) throw new DomainError("FORBIDDEN", "No access to this workspace");
  if (ws.status === "ARCHIVED") throw new DomainError("FORBIDDEN", "This workspace is archived", { archived: true });
  let access: WorkspaceAccess | undefined = deps.cache.get(user.id, input.workspaceId);
  if (!access) {
    access = await deps.access.access(user, input.workspaceId, input.requestId);
    deps.cache.set(user.id, input.workspaceId, access);
  }
  return {
    ctx: { workspaceId: input.workspaceId, orgId: user.orgId, userId: user.id, isOrgAdmin: false, actorType: "user", requestId: input.requestId, actingAs: actingAsIn(access) },
    user: { id: user.id, orgId: user.orgId, email: user.email, name: user.name },
    isOrgAdmin: access.isOrgAdmin,
    roles: [...new Set(access.assignments.map((a) => a.role))] as Role[],
    assignments: access.assignments,
  };
}

/** The route's (or tool's) declared permission, against the caller's roles in the workspace. */
export function authorize(auth: AuthContext, permission: RoutePermission): void {
  // The interceptor never calls authorize() for a "public" route (it returns before
  // authenticating at all), but the branch keeps this function total over RoutePermission.
  if (permission === "public") return;
  if (permission === "authenticated") return;
  // Signed Slack requests never reach here (the interceptor verifies them without a JWT).
  if (permission === "slack.signed") throw new DomainError("FORBIDDEN", "Slack routes take no JWT");
  // T-040: org-level administration (workspaces, templates, tours); with or without a workspace.
  if (permission === "org.admin") {
    if (!auth.isOrgAdmin) throw new DomainError("FORBIDDEN", "Only an org admin can do this", { permission });
    return;
  }
  if (auth.ctx.workspaceId === null) throw new DomainError("VALIDATION", "Workspace required (route :ws or X-Workspace-Id)");
  if (auth.roles.length === 0) throw new DomainError("FORBIDDEN", "No role in this workspace");
  if (permission !== "workspace.member" && !can(auth.roles, permission)) throw new DomainError("FORBIDDEN", `Missing permission ${permission}`, { permission });
}
