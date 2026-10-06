/**
 * Boot check (audit S-3): the API must run as a role RLS actually restricts. A role with
 * `rolbypassrls` or `rolsuper` skips every policy on every FORCE-RLS tenant table — connecting as
 * one, even by accident (a missing or misnamed `APP_DATABASE_URL` secret in a revision), would
 * make `withTenant()`'s workspace scoping a no-op while the service otherwise looks healthy.
 * `common.module.ts` runs this once, synchronously with Prisma client construction, so a
 * misconfigured revision fails at boot instead of serving cross-tenant data.
 */

/** The narrow slice of PrismaClient this check needs — a fake query result is enough to unit test it. */
export interface RoleQueryClient {
  $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T>;
}

export interface RoleFlags {
  rolbypassrls: boolean;
  rolsuper: boolean;
}

export async function assertAppRoleIsRestricted(client: RoleQueryClient): Promise<void> {
  const rows = await client.$queryRawUnsafe<RoleFlags[]>("SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user");
  const role = rows[0];
  // Fail closed (AGENTS §4): an unrecognised current_user is as suspicious as a confirmed bypass role.
  if (!role || role.rolbypassrls || role.rolsuper) {
    throw new Error("Refusing to start: the API must not run as a BYPASSRLS/superuser role");
  }
}
