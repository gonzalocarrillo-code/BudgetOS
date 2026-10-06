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
  /**
   * ADR-052: "superadmin" when the caller acts in a workspace through the org-wide role only. Sets
   * `app.acting_as`, which `audit_event.actor_context` defaults from.
   */
  actingAs?: "superadmin" | null | undefined;
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
      // One statement for the four settings: every command pays this per transaction (ADR-0079).
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.workspace_id', $1, true), set_config('app.org_id', $2, true), set_config('app.user_id', $3, true), set_config('app.is_org_admin', $4, true), set_config('app.acting_as', $5, true)`,
        ctx.workspaceId ?? "",
        ctx.orgId ?? "",
        ctx.userId ?? "",
        String(ctx.isOrgAdmin),
        ctx.actingAs ?? "",
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

/**
 * W0-6 (docs/STACK_AUDIT_2026-10-04.md S-2, S-3, S-21): the owner connection (`DATABASE_URL`) has
 * had no BYPASSRLS since W2-3, matching production's owner — so fixture setup, assertion queries
 * and one-off ops scripts (`apps/api/src/deploy/bootstrap.ts`, `slack-sandbox.ts`) that read or
 * write across workspaces through the raw owner connection, which used to work only because the
 * local/CI owner was a Postgres superuser (superusers always bypass RLS, independent of the
 * BYPASSRLS attribute) or relied on luck in production, now need an explicit tenant context like
 * real request code gets from `withTenant`. No HTTP request path uses the owner connection
 * (`apps/api/src/common/common.module.ts` refuses to boot on anything but `APP_DATABASE_URL`); the
 * only legitimate owner callers are migrations, seed, tests and deploy-time scripts like those.
 *
 * `asOrgAdmin` sets only the session GUCs every generic `tenant_isolation` policy and the
 * `org_admin_write`-style policies check (`app_is_org_admin()`, optionally `app_org_id()` for
 * policies that also require the org to match, e.g. `workspace`) — transaction-local (`SET LOCAL`
 * via `set_config(..., true)`), so it never outlives this one call and grants nothing to the role
 * itself. It does not help with the three pre-tenant identity tables (`organization`, `app_user`,
 * `role_assignment`), which have their own unconditional `owner_bootstrap` policy
 * (`20261010050000_owner_bootstrap_policies`) because bootstrap.ts must write them before any org
 * exists to set a context for.
 *
 * `opts.timeoutMs` (default 30s, Prisma's own default) raises the interactive transaction's
 * timeout for a caller whose `fn` does genuinely more work than that — e.g. `deleteWorkspaceForTests`
 * hard-deleting a 10k-row bulk-perf fixture — rather than every caller inheriting a cap sized for
 * the common case.
 */
export async function asOrgAdmin<T>(
  prisma: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  orgId?: string | null,
  opts?: { timeoutMs?: number },
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.is_org_admin', 'true', true), set_config('app.org_id', $1, true)`,
        orgId ?? "",
      );
      return fn(tx);
    },
    { timeout: opts?.timeoutMs ?? 30_000 },
  );
}
