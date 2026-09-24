import type { ScopedRole } from "@budget/domain";
import { Injectable } from "@nestjs/common";

export interface WorkspaceAccess {
  isOrgAdmin: boolean;
  /** Assignments that apply in the workspace (direct and through groups), ORG_ADMIN included. */
  assignments: ScopedRole[];
}

export interface RoleCache {
  get(userId: string, workspaceId: string | null): WorkspaceAccess | undefined;
  set(userId: string, workspaceId: string | null, access: WorkspaceAccess): void;
  /** Called after any role or group change so revocations apply on the next request. */
  clear(): void;
}

export const ROLE_CACHE = Symbol("ROLE_CACHE");
export const ROLE_CACHE_TTL_MS = 60_000;

/** Per-process TTL cache (spec §4: roles cached 60 s). */
@Injectable()
export class MemoryRoleCache implements RoleCache {
  private readonly entries = new Map<string, { at: number; access: WorkspaceAccess }>();

  constructor(private readonly now: () => number = Date.now) {}

  private key(userId: string, workspaceId: string | null): string {
    return `${userId}:${workspaceId ?? "-"}`;
  }

  get(userId: string, workspaceId: string | null): WorkspaceAccess | undefined {
    const key = this.key(userId, workspaceId);
    const hit = this.entries.get(key);
    if (hit === undefined) return undefined;
    if (this.now() - hit.at >= ROLE_CACHE_TTL_MS) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.access;
  }

  set(userId: string, workspaceId: string | null, access: WorkspaceAccess): void {
    this.entries.set(this.key(userId, workspaceId), { at: this.now(), access });
  }

  clear(): void {
    this.entries.clear();
  }
}
