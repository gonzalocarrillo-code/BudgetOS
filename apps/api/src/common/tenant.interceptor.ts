import { randomUUID } from "node:crypto";
import { DomainError, can, type Role } from "@budget/domain";
import { Inject, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { from, switchMap, type Observable } from "rxjs";
import { AccessRepository } from "./auth/access.repository.js";
import { JwtVerifier } from "./auth/jwt-verifier.js";
import { ROLE_CACHE, type RoleCache, type WorkspaceAccess } from "./auth/role-cache.js";
import { PERMISSION_KEY, type RoutePermission } from "./permission.decorator.js";
import type { AuthContext, TenantRequest } from "./tenant.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Builds the TenantContext for every request (spec §4): verified JWT (`sub`, `email`) +
 * workspace from the `:ws` route param or `X-Workspace-Id`, roles from RoleAssignment
 * (direct and via groups, cached 60 s), then enforces the route's declared permission.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(JwtVerifier) private readonly verifier: JwtVerifier,
    @Inject(AccessRepository) private readonly access: AccessRepository,
    @Inject(ROLE_CACHE) private readonly cache: RoleCache,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const permission = this.reflector.getAllAndOverride<RoutePermission | undefined>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<TenantRequest>();
    return from(this.authorize(request, permission)).pipe(switchMap(() => next.handle()));
  }

  private async authorize(request: TenantRequest, permission: RoutePermission | undefined): Promise<void> {
    if (permission === undefined) {
      throw new DomainError("FORBIDDEN", "Route declares no permission");
    }
    const identity = await this.verifier.verify(header(request, "authorization"));
    const user = await this.access.findUser(identity);
    if (user === null || !user.isActive) throw new DomainError("FORBIDDEN", "Unknown or inactive user");

    const workspaceId = resolveWorkspace(request);
    const requestId = header(request, "x-request-id") ?? randomUUID();
    if (workspaceId !== null) {
      const orgId = await this.access.workspaceOrg(workspaceId, user, requestId);
      // Same answer for "no such workspace" and "another org's workspace".
      if (orgId !== user.orgId) throw new DomainError("FORBIDDEN", "No access to this workspace");
    }
    const access = await this.cachedAccess(user, workspaceId, requestId);
    const roles = [...new Set(access.assignments.map((a) => a.role))] as Role[];

    if (permission !== "authenticated") {
      if (workspaceId === null) throw new DomainError("VALIDATION", "Workspace required (route :ws or X-Workspace-Id)");
      if (roles.length === 0) throw new DomainError("FORBIDDEN", "No role in this workspace");
      if (permission !== "workspace.member" && !can(roles, permission)) {
        throw new DomainError("FORBIDDEN", `Missing permission ${permission}`, { permission });
      }
    }

    const tenant: AuthContext = {
      ctx: {
        workspaceId,
        orgId: user.orgId,
        userId: user.id,
        isOrgAdmin: access.isOrgAdmin && workspaceId === null,
        actorType: "user",
        requestId,
      },
      user: { id: user.id, orgId: user.orgId, email: user.email, name: user.name },
      isOrgAdmin: access.isOrgAdmin,
      roles,
      assignments: access.assignments,
    };
    request.tenant = tenant;
  }

  private async cachedAccess(
    user: { id: string; orgId: string },
    workspaceId: string | null,
    requestId: string,
  ): Promise<WorkspaceAccess> {
    const hit = this.cache.get(user.id, workspaceId);
    if (hit) return hit;
    const fresh = await this.access.access(user, workspaceId, requestId);
    this.cache.set(user.id, workspaceId, fresh);
    return fresh;
  }
}

function header(request: TenantRequest, name: string): string | undefined {
  const v = request.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function resolveWorkspace(request: TenantRequest): string | null {
  const fromRoute = request.params?.["ws"];
  const fromHeader = header(request, "x-workspace-id");
  if (fromRoute !== undefined && fromHeader !== undefined && fromRoute !== fromHeader) {
    throw new DomainError("VALIDATION", "X-Workspace-Id does not match the route workspace");
  }
  const ws = fromRoute ?? fromHeader ?? null;
  if (ws !== null && !UUID.test(ws)) throw new DomainError("VALIDATION", "Workspace id must be a uuid");
  return ws;
}
