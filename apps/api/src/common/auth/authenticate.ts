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

export async function authenticate(deps: AuthDeps, input: { authorization: string | undefined; workspaceId: string | null; requestId: string; actorType?: "user" | "mcp" }): Promise<AuthContext> {
  const identity = await deps.verifier.verify(input.authorization);
  const user = await deps.access.findUser(identity);
  if (user === null || !user.isActive) throw new DomainError("FORBIDDEN", "Unknown or inactive user");
  const { workspaceId, requestId } = input;
  if (workspaceId !== null) {
    const orgId = await deps.access.workspaceOrg(workspaceId, user, requestId);
    // Same answer for "no such workspace" and "another org's workspace".
    if (orgId !== user.orgId) throw new DomainError("FORBIDDEN", "No access to this workspace");
  }
  let access: WorkspaceAccess | undefined = deps.cache.get(user.id, workspaceId);
  if (!access) {
    access = await deps.access.access(user, workspaceId, requestId);
    deps.cache.set(user.id, workspaceId, access);
  }
  return {
    ctx: { workspaceId, orgId: user.orgId, userId: user.id, isOrgAdmin: access.isOrgAdmin && workspaceId === null, actorType: input.actorType ?? "user", requestId },
    user: { id: user.id, orgId: user.orgId, email: user.email, name: user.name },
    isOrgAdmin: access.isOrgAdmin,
    roles: [...new Set(access.assignments.map((a) => a.role))] as Role[],
    assignments: access.assignments,
  };
}

/**
 * An AuthContext for an email another trusted system vouches for (the Slack user of a linked
 * Slack team, product feedback 2026-09-28): the same user, workspace and role checks as a JWT.
 */
export async function authenticateVerifiedEmail(deps: Pick<AuthDeps, "access" | "cache">, input: { email: string; workspaceId: string; requestId: string }): Promise<AuthContext> {
  const user = await deps.access.findUser({ sub: `external:${input.email}`, email: input.email, emailVerified: true, googleSub: null });
  if (user === null || !user.isActive) throw new DomainError("FORBIDDEN", "No active Budget OS account for this Slack user's email");
  const orgId = await deps.access.workspaceOrg(input.workspaceId, user, input.requestId);
  if (orgId !== user.orgId) throw new DomainError("FORBIDDEN", "No access to this workspace");
  let access: WorkspaceAccess | undefined = deps.cache.get(user.id, input.workspaceId);
  if (!access) {
    access = await deps.access.access(user, input.workspaceId, input.requestId);
    deps.cache.set(user.id, input.workspaceId, access);
  }
  return {
    ctx: { workspaceId: input.workspaceId, orgId: user.orgId, userId: user.id, isOrgAdmin: false, actorType: "user", requestId: input.requestId },
    user: { id: user.id, orgId: user.orgId, email: user.email, name: user.name },
    isOrgAdmin: access.isOrgAdmin,
    roles: [...new Set(access.assignments.map((a) => a.role))] as Role[],
    assignments: access.assignments,
  };
}

/** The route's (or tool's) declared permission, against the caller's roles in the workspace. */
export function authorize(auth: AuthContext, permission: RoutePermission): void {
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
