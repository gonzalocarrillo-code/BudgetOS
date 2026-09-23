import { DomainError, can, type Role } from "@budget/domain";
import { audit, bumpDataVersion, outbox, withTenant, type TenantContext, type Tx } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import type { z } from "zod";

export interface WorkspaceRef {
  id: string;
  orgId: string;
}

export function parseInput<T>(
  schema: {
    safeParse: (raw: unknown) => { success: true; data: T } | { success: false; error: z.ZodError };
  },
  raw: unknown,
): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new DomainError("VALIDATION", "Invalid registry input", {
      issues: parsed.error.flatten(),
    });
  }
  return parsed.data;
}

export function assertCanManage(roles: Role[]): void {
  if (!can(roles, "registry.manage")) {
    throw new DomainError("FORBIDDEN", "Cannot manage the registry");
  }
}

export function requireActor(ctx: TenantContext): { workspaceId: string; userId: string } {
  if (ctx.workspaceId === null || ctx.userId === null) {
    throw new DomainError("VALIDATION", "Workspace and user are required");
  }
  return { workspaceId: ctx.workspaceId, userId: ctx.userId };
}

export async function inWorkspace<T>(
  prisma: PrismaClient,
  ctx: TenantContext,
  fn: (tx: Tx, workspace: WorkspaceRef, actorId: string) => Promise<T>,
  timeoutMs = 15_000,
): Promise<T> {
  const actor = requireActor(ctx);
  return withTenant(
    prisma,
    ctx,
    async (tx) => {
      const workspace = await tx.workspace.findUnique({ where: { id: actor.workspaceId } });
      if (workspace === null) {
        throw new DomainError("NOT_FOUND", "Workspace not found");
      }
      return fn(tx, { id: workspace.id, orgId: workspace.orgId }, actor.userId);
    },
    { timeoutMs },
  );
}

export async function recordChange(
  tx: Tx,
  ctx: TenantContext,
  args: {
    workspaceId: string;
    orgId: string;
    action: string;
    entityType: string;
    entityId: string;
    kind: string;
    after: Record<string, unknown>;
  },
): Promise<void> {
  await audit(tx, {
    workspaceId: args.workspaceId,
    actorId: ctx.userId,
    actorType: ctx.actorType,
    action: args.action,
    entityType: args.entityType,
    entityId: args.entityId,
    after: args.after,
    requestId: ctx.requestId,
  });
  await outbox(tx, {
    workspaceId: args.workspaceId,
    topic: "registry.changed",
    payload: {
      requestId: ctx.requestId,
      orgId: args.orgId,
      kind: args.kind,
      ...args.after,
    },
  });
  await bumpDataVersion(tx, args.workspaceId);
}
