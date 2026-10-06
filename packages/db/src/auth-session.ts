import type { PrismaClient } from "@prisma/client";

/**
 * Server-side sessions (W5-3, audit S-11). Every function here calls a SECURITY DEFINER RPC
 * (migration 20261011000000); none of them need a tenant transaction (withTenant/withIdentity) —
 * login and logout both run before any tenant context exists.
 */
export interface CreateSessionInput {
  jti: string;
  userId: string;
  orgId: string;
  expiresAt: Date;
  userAgent: string | null;
}

/** app_create_session: a new session row for a provisioned user, plus its opportunistic sweep. */
export async function createSession(prisma: PrismaClient, input: CreateSessionInput): Promise<void> {
  await prisma.$executeRaw`SELECT app_create_session(${input.jti}, ${input.userId}::uuid, ${input.orgId}::uuid, ${input.expiresAt}::timestamptz, ${input.userAgent})`;
}

/** app_session_live: not revoked and not expired. */
export async function sessionLive(prisma: PrismaClient, jti: string): Promise<boolean> {
  const [row] = await prisma.$queryRaw<Array<{ live: boolean }>>`SELECT app_session_live(${jti}) AS live`;
  return row?.live === true;
}

/** app_revoke_session: ends exactly this session (logout). */
export async function revokeSession(prisma: PrismaClient, jti: string): Promise<void> {
  await prisma.$executeRaw`SELECT app_revoke_session(${jti})`;
}

/** app_revoke_all_sessions: ends every live session of whoever this jti belongs to ("sign out everywhere"). Returns how many. */
export async function revokeAllSessions(prisma: PrismaClient, jti: string): Promise<number> {
  const [row] = await prisma.$queryRaw<Array<{ revoked: number }>>`SELECT app_revoke_all_sessions(${jti}) AS revoked`;
  return row?.revoked ?? 0;
}
