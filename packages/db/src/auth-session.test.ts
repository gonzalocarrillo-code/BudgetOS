import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession, revokeAllSessions, revokeSession, sessionLive } from "./auth-session.js";
import { consumeOauthCode, consumeRefreshToken, issueOauthCode, issueRefreshToken } from "./oauth-store.js";
import { withTenant, type TenantContext } from "./tenant.js";

/**
 * W5-3 (audit S-11, S-12): the session store and the MCP refresh/code store, migration
 * 20261011000000. These RPCs are SECURITY DEFINER, so they're exercised directly against
 * PrismaClient (no withTenant) the same way the real login/logout/token routes call them; the RLS
 * isolation test below is the one place a tenant context (withTenant) is needed, to read the table
 * the way a future self-service "your sessions" endpoint would.
 */

const envFile = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const i = line.indexOf("=");
    const key = line.slice(0, i).trim();
    if (i > 0 && !line.trim().startsWith("#") && process.env[key] === undefined) process.env[key] = line.slice(i + 1).trim();
  }
}
const owner = new PrismaClient({ datasources: { db: { url: process.env["DATABASE_URL"] ?? "" } } });
const app = new PrismaClient({ datasources: { db: { url: process.env["APP_DATABASE_URL"] ?? "" } } });
// Code issuance (oauth.consent/code) runs on the api side as budget_app; code exchange and
// refresh rotation run on the MCP server's own endpoint as budget_mcp (migration 20261011000000's
// grants mirror exactly this split).
const mcp = new PrismaClient({ datasources: { db: { url: process.env["MCP_DATABASE_URL"] ?? "" } } });

const orgId = randomUUID();
const userA = randomUUID();
const userB = randomUUID();
const ctx = (userId: string): TenantContext => ({ workspaceId: null, orgId, userId, isOrgAdmin: false, actorType: "user", requestId: `w53-${randomUUID()}` });
const hourFromNow = () => new Date(Date.now() + 3_600_000);

beforeAll(async () => {
  await owner.organization.create({ data: { id: orgId, name: "w5-3" } });
  await owner.user.createMany({ data: [userA, userB].map((id) => ({ id, orgId, email: `${id}@w53.test`, name: "Someone", googleSub: `g-${id}` })) });
});

afterAll(async () => {
  await owner.authSession.deleteMany({ where: { orgId } });
  await owner.user.deleteMany({ where: { orgId } });
  await owner.organization.delete({ where: { id: orgId } });
  await Promise.all([owner.$disconnect(), app.$disconnect(), mcp.$disconnect()]);
});

describe("auth_session (S-11)", () => {
  it("is live until revoked, then refused", async () => {
    const jti = `s-${randomUUID()}`;
    await createSession(app, { jti, userId: userA, orgId, expiresAt: hourFromNow(), userAgent: "vitest" });
    expect(await sessionLive(app, jti)).toBe(true);
    await revokeSession(app, jti);
    expect(await sessionLive(app, jti)).toBe(false);
    // Revoking again (e.g. a double logout) is a no-op, not an error.
    await expect(revokeSession(app, jti)).resolves.toBeUndefined();
  });

  it("an unknown jti is simply not live", async () => {
    expect(await sessionLive(app, `s-${randomUUID()}`)).toBe(false);
  });

  it("'sign out everywhere' revokes every live session of that jti's user, and nobody else's", async () => {
    const [j1, j2, j3] = [`s-${randomUUID()}`, `s-${randomUUID()}`, `s-${randomUUID()}`];
    await createSession(app, { jti: j1, userId: userA, orgId, expiresAt: hourFromNow(), userAgent: null });
    await createSession(app, { jti: j2, userId: userA, orgId, expiresAt: hourFromNow(), userAgent: null });
    const other = `s-${randomUUID()}`;
    await createSession(app, { jti: other, userId: userB, orgId, expiresAt: hourFromNow(), userAgent: null });
    const revoked = await revokeAllSessions(app, j1);
    expect(revoked).toBe(2);
    expect(await sessionLive(app, j1)).toBe(false);
    expect(await sessionLive(app, j2)).toBe(false);
    expect(await sessionLive(app, other)).toBe(true); // user B's own session is untouched
    expect(await revokeAllSessions(app, j3)).toBe(0); // an unknown jti revokes nothing
  });

  it("user A cannot see user B's sessions (RLS, own rows only)", async () => {
    const mine = `s-${randomUUID()}`;
    const theirs = `s-${randomUUID()}`;
    await createSession(app, { jti: mine, userId: userA, orgId, expiresAt: hourFromNow(), userAgent: null });
    await createSession(app, { jti: theirs, userId: userB, orgId, expiresAt: hourFromNow(), userAgent: null });
    const seenByA = await withTenant(app, ctx(userA), (tx) => tx.authSession.findMany({ where: { jti: { in: [mine, theirs] } } }));
    expect(seenByA.map((r) => r.jti)).toEqual([mine]);
    const seenByB = await withTenant(app, ctx(userB), (tx) => tx.authSession.findMany({ where: { jti: { in: [mine, theirs] } } }));
    expect(seenByB.map((r) => r.jti)).toEqual([theirs]);
  });

  it("budget_app cannot insert or delete a session directly, only through the RPCs", async () => {
    await expect(app.$executeRawUnsafe(`INSERT INTO auth_session (jti, user_id, org_id, expires_at) VALUES ('direct', $1::uuid, $2::uuid, now())`, userA, orgId)).rejects.toThrow(/permission denied/);
    await expect(app.$executeRawUnsafe(`DELETE FROM auth_session WHERE user_id = $1::uuid`, userA)).rejects.toThrow(/permission denied/);
  });
});

describe("oauth_code and oauth_refresh (S-12)", () => {
  const clientId = `client-${randomUUID()}`;
  const minuteFromNow = () => new Date(Date.now() + 60_000);

  it("a code is consumed exactly once", async () => {
    const hash = `c-${randomUUID()}`;
    await issueOauthCode(app, hash, minuteFromNow());
    expect(await consumeOauthCode(mcp, hash)).toBe(true);
    expect(await consumeOauthCode(mcp, hash)).toBe(false); // replay
    expect(await consumeOauthCode(mcp, `c-${randomUUID()}`)).toBe(false); // unknown
  });

  it("a refresh token rotates: consuming it once succeeds, consuming it again revokes the whole chain", async () => {
    const started = new Date();
    const j1 = `r-${randomUUID()}`;
    const j2 = `r-${randomUUID()}`; // the next token in the same chain, issued (as the real flow would) before j1 is ever reused
    await issueRefreshToken(mcp, { jti: j1, clientId, userId: userA, chainStartedAt: started, expiresAt: hourFromNow() });
    await issueRefreshToken(mcp, { jti: j2, clientId, userId: userA, chainStartedAt: started, expiresAt: hourFromNow() });

    const first = await consumeRefreshToken(mcp, j1);
    expect(first).toMatchObject({ ok: true, reused: false, clientId, userId: userA });

    const replay = await consumeRefreshToken(mcp, j1);
    expect(replay).toMatchObject({ ok: false, reused: true });

    // Reuse revoked the whole (user, client) chain, including j2 which was never itself replayed.
    const chained = await consumeRefreshToken(mcp, j2);
    expect(chained).toMatchObject({ ok: false, reused: false });
  });

  it("an unknown jti is refused without being 'reused'", async () => {
    expect(await consumeRefreshToken(mcp, `r-${randomUUID()}`)).toMatchObject({ ok: false, reused: false, clientId: null, userId: null });
  });

  it("enforces the 90-day absolute chain lifetime regardless of the token's own (unexpired) TTL", async () => {
    const jti = `r-${randomUUID()}`;
    const longAgo = new Date(Date.now() - 91 * 86_400_000);
    await issueRefreshToken(mcp, { jti, clientId, userId: userA, chainStartedAt: longAgo, expiresAt: hourFromNow() });
    expect(await consumeRefreshToken(mcp, jti)).toMatchObject({ ok: false, reused: false });
  });

  it("budget_app has no table-level access to either table: every write goes through app_issue_code", async () => {
    await expect(app.$executeRawUnsafe(`SELECT 1 FROM oauth_refresh LIMIT 1`)).rejects.toThrow(/permission denied/);
    await expect(app.$executeRawUnsafe(`INSERT INTO oauth_code (code_hash, expires_at) VALUES ('direct', now())`)).rejects.toThrow(/permission denied/);
  });
});
