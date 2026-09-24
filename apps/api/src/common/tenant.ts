import { DomainError, type Role, type ScopedRole } from "@budget/domain";
import type { TenantContext } from "@budget/db";
import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

/** What the tenant interceptor attaches to `request.tenant`. */
export interface AuthContext {
  ctx: TenantContext;
  user: { id: string; orgId: string; email: string; name: string };
  /** Distinct roles in `ctx.workspaceId` (ORG_ADMIN included); empty when no workspace. */
  roles: Role[];
  assignments: ScopedRole[];
}

export interface TenantRequest {
  headers: Record<string, string | string[] | undefined>;
  params?: Record<string, string | undefined>;
  tenant?: AuthContext;
}

export const Tenant = createParamDecorator((_data: unknown, context: ExecutionContext): AuthContext => {
  const tenant = context.switchToHttp().getRequest<TenantRequest>().tenant;
  if (tenant === undefined) throw new DomainError("UNAUTHENTICATED", "No tenant on request");
  return tenant;
});
