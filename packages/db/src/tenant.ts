import { Prisma, PrismaClient } from "@prisma/client";

export interface TenantContext {
  workspaceId: string | null;
  /**
   * The caller's organization (`app.org_id`). Scopes the org-admin bypass to this org's workspaces
   * and org-wide registry rows to this org. Null reads no org-wide rows and no bypass rows.
   */
  orgId: string | null;
  userId: string | null;
  isOrgAdmin: boolean;
  actorType: "user" | "system" | "mcp";
  requestId: string;
}

/**
 * Runs fn inside one transaction with RLS session settings applied.
 * SET LOCAL is transaction-scoped, so settings never leak across pooled connections.
 */
export async function withTenant<T>(
  prisma: PrismaClient,
  ctx: TenantContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  opts: { isolation?: Prisma.TransactionIsolationLevel; timeoutMs?: number } = {},
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.workspace_id', $1, true)`,
        ctx.workspaceId ?? "",
      );
      await tx.$executeRawUnsafe(`SELECT set_config('app.org_id', $1, true)`, ctx.orgId ?? "");
      await tx.$executeRawUnsafe(`SELECT set_config('app.user_id', $1, true)`, ctx.userId ?? "");
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.is_org_admin', $1, true)`,
        String(ctx.isOrgAdmin),
      );
      return fn(tx);
    },
    { isolationLevel: opts.isolation ?? "ReadCommitted", timeout: opts.timeoutMs ?? 15_000 },
  );
}
