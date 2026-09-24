import { DomainError, type Role, type ScopedRole } from "@budget/domain";
import type { TenantContext } from "@budget/db";
import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

/** What the tenant interceptor attaches to `request.tenant`. */
export interface AuthContext {
  /**
   * `ctx.isOrgAdmin` is the RLS bypass (`app.is_org_admin`). It is set only for org-level calls
   * with no workspace, so an org admin acting in a workspace stays isolated to it by RLS.
   */
  ctx: TenantContext;
  /** The caller holds ORG_ADMIN (org-wide). Use this for authorization decisions. */
  isOrgAdmin: boolean;
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

/** Explicit elevation for the org-admin paths that must write org-wide rows (registry). */
export function orgAdminCtx(auth: AuthContext): TenantContext {
  return { ...auth.ctx, isOrgAdmin: auth.isOrgAdmin };
}
