import type { PrismaClient } from "@prisma/client";

/**
 * MCP OAuth codes and refresh tokens (W5-3, audit S-12). `@budget/api`'s McpOAuth calls these
 * through its optional `OAuthStore`: code issuance runs on the api side (budget_app, EXECUTE on
 * app_issue_code only), code exchange and refresh rotation run on the MCP side (budget_mcp,
 * EXECUTE on the other three only) — see migration 20261011000000.
 */
export async function issueOauthCode(prisma: PrismaClient, codeHash: string, expiresAt: Date): Promise<void> {
  await prisma.$executeRaw`SELECT app_issue_code(${codeHash}, ${expiresAt}::timestamptz)`;
}

/** Single use: true only the first time this code is consumed, before it expires. */
export async function consumeOauthCode(prisma: PrismaClient, codeHash: string): Promise<boolean> {
  const [row] = await prisma.$queryRaw<Array<{ ok: boolean }>>`SELECT app_consume_code(${codeHash}) AS ok`;
  return row?.ok === true;
}

export interface IssueRefreshInput {
  jti: string;
  clientId: string;
  userId: string;
  chainStartedAt: Date;
  expiresAt: Date;
}

export async function issueRefreshToken(prisma: PrismaClient, input: IssueRefreshInput): Promise<void> {
  await prisma.$executeRaw`SELECT app_issue_refresh(${input.jti}, ${input.clientId}, ${input.userId}::uuid, ${input.chainStartedAt}::timestamptz, ${input.expiresAt}::timestamptz)`;
}

export interface ConsumeRefreshResult {
  /** True: this token was live and is now consumed; the caller may mint the next one in the chain. */
  ok: boolean;
  /** True: this token had already been used once (replay) — the whole chain was just revoked. */
  reused: boolean;
  clientId: string | null;
  userId: string | null;
  chainStartedAt: Date | null;
}

/** app_consume_refresh: atomic rotate-and-check, see migration 20261011000000 for the exact rules. */
export async function consumeRefreshToken(prisma: PrismaClient, jti: string): Promise<ConsumeRefreshResult> {
  const [row] = await prisma.$queryRaw<
    Array<{ ok: boolean; reused: boolean; client_id: string | null; user_id: string | null; chain_started_at: Date | null }>
  >`SELECT * FROM app_consume_refresh(${jti})`;
  return {
    ok: row?.ok === true,
    reused: row?.reused === true,
    clientId: row?.client_id ?? null,
    userId: row?.user_id ?? null,
    chainStartedAt: row?.chain_started_at ?? null,
  };
}
