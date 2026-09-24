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

/** A verified token's identifiers (spec §4). `email` only when the provider verified it. */
export interface IdentityLookup {
  subs: string[];
  email: string | null;
}

/**
 * Runs fn before the caller's org is known: the only rows visible are the app_user rows whose
 * google_sub is in `subs` or whose email is `email` (migration 20260924030000). No tenant
 * setting is applied, so every other tenant and identity table reads empty.
 */
export async function withIdentity<T>(
  prisma: PrismaClient,
  identity: IdentityLookup,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.auth_subs', $1, true)`, JSON.stringify(identity.subs));
    await tx.$executeRawUnsafe(`SELECT set_config('app.auth_email', $1, true)`, identity.email ?? "");
    return fn(tx);
  });
}
