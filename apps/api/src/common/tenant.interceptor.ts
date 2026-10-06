import { randomUUID } from "node:crypto";
import { DomainError } from "@budget/domain";
import { Inject, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PinoLogger } from "nestjs-pino";
import { from, switchMap, type Observable } from "rxjs";
import { AccessRepository } from "./auth/access.repository.js";
import { JwtVerifier } from "./auth/jwt-verifier.js";
import { authenticate, authorize } from "./auth/authenticate.js";
import { ROLE_CACHE, type RoleCache } from "./auth/role-cache.js";
import { LIFECYCLE_KEY, PERMISSION_KEY, type RoutePermission } from "./permission.decorator.js";
import type { TenantRequest } from "./tenant.js";
import { verifySlackSignature } from "../modules/slack/signature.js";

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
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const permission = this.reflector.getAllAndOverride<RoutePermission | undefined>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const lifecycle = this.reflector.getAllAndOverride<boolean | undefined>(LIFECYCLE_KEY, [context.getHandler(), context.getClass()]) === true;
    const request = context.switchToHttp().getRequest<TenantRequest>();
    return from(this.authorize(request, permission, lifecycle)).pipe(switchMap(() => next.handle()));
  }

  private async authorize(request: TenantRequest, permission: RoutePermission | undefined, lifecycle = false): Promise<void> {
    if (permission === undefined) {
      throw new DomainError("FORBIDDEN", "Route declares no permission");
    }
    // W5-1: the same exemption /health gets (never entering Nest's router), but declared so the
    // interceptor's fail-closed default still applies to every route that doesn't opt out.
    if (permission === "public") return;
    if (permission === "slack.signed") {
      verifySlackSignature({
        rawBody: (request as unknown as { rawBody?: string }).rawBody,
        timestamp: header(request, "x-slack-request-timestamp"),
        signature: header(request, "x-slack-signature"),
        secret: process.env["SLACK_SIGNING_SECRET"],
        retryNum: header(request, "x-slack-retry-num"),
        retryReason: header(request, "x-slack-retry-reason"),
      });
      return;
    }
    // Fastify assigns `request.id` (main.ts's genReqId: the incoming X-Request-Id, or a fresh uuid)
    // before any middleware runs, and pino-http keeps it rather than generating its own (W5-1), so
    // this is the same id the request's log lines carry. request.id is only undefined outside a
    // real Fastify request (a unit test building a bare TenantRequest).
    const requestId = request.id ?? randomUUID();
    const tenant = await authenticate(
      { verifier: this.verifier, access: this.access, cache: this.cache },
      { authorization: this.verifier.credential(request.headers), workspaceId: resolveWorkspace(request), requestId, use: lifecycle ? "lifecycle" : request.method === "GET" || request.method === "HEAD" ? "read" : "write" },
    );
    authorize(tenant, permission);
    request.tenant = tenant;
    // W5-1 (AGENTS §4 logging): every log line for the rest of this request carries workspaceId and
    // actorId once resolved, alongside the requestId pino-http already bound from request.id.
    this.logger.assign({ workspaceId: tenant.ctx.workspaceId, actorId: tenant.ctx.userId });
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
