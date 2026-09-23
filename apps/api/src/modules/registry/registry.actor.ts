import { DomainError, type Role } from "@budget/domain";
import type { TenantContext } from "@budget/db";
import { Injectable } from "@nestjs/common";

export interface RegistryActor {
  current(workspaceId: string | null): { ctx: TenantContext; roles: Role[] };
}

export const REGISTRY_ACTOR = Symbol("REGISTRY_ACTOR");

@Injectable()
export class UnauthenticatedActor implements RegistryActor {
  current(workspaceId: string | null): { ctx: TenantContext; roles: Role[] } {
    void workspaceId;
    throw new DomainError("FORBIDDEN", "Unauthenticated");
  }
}
