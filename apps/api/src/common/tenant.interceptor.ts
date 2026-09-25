import { randomUUID } from "node:crypto";
import { DomainError } from "@budget/domain";
import { Inject, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { from, switchMap, type Observable } from "rxjs";
import { AccessRepository } from "./auth/access.repository.js";
import { JwtVerifier } from "./auth/jwt-verifier.js";
import { authenticate, authorize } from "./auth/authenticate.js";
import { ROLE_CACHE, type RoleCache } from "./auth/role-cache.js";
import { PERMISSION_KEY, type RoutePermission } from "./permission.decorator.js";
import type { TenantRequest } from "./tenant.js";

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
    const tenant = await authenticate(
      { verifier: this.verifier, access: this.access, cache: this.cache },
      { authorization: header(request, "authorization"), workspaceId: resolveWorkspace(request), requestId: header(request, "x-request-id") ?? randomUUID() },
    );
    authorize(tenant, permission);
    request.tenant = tenant;
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
