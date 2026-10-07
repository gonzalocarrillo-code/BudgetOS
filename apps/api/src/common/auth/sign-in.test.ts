import { randomUUID } from "node:crypto";
import { asOrgAdmin } from "@budget/db";
import { deleteWorkspaceForTests } from "@budget/workers";
import { Logger } from "@nestjs/common";
import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { appDb, ownerDb, startHarness, testUser, type Harness, type TestUser } from "../../test-support/harness.js";
import { AccessRepository } from "./access.repository.js";
import { authenticateVerifiedEmail } from "./authenticate.js";
import { MemoryRoleCache } from "./role-cache.js";

/**
 * Round 11 (PR 1): "Not signed in yet" never clears for someone added by email, because nothing
 * ever wrote google_sub on their first Google sign-in. app_record_sign_in() (migration
 * 20261020060000_user_sign_in) binds it and stamps last_sign_in_at; recordSignIn()/authenticate()
 * call it at most once per 15 min and audit only the first bind.
 */

const owner = ownerDb();
let h: Harness;
const orgId = randomUUID();
const otherOrg = randomUUID();
const ws = randomUUID();
const admin = testUser("signin-admin", randomUUID());
const invited = testUser("signin-invited", randomUUID());
const neverSignsIn = testUser("signin-never", randomUUID());

async function poll<T>(fn: () => Promise<T | null | undefined>, ms = 2000, step = 50): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("poll timed out");
    await new Promise((r) => setTimeout(r, step));
  }
}

beforeAll(async () => {
  for (const [id, name] of [[orgId, "signin"], [otherOrg, "signin-other"]] as const) await owner.organization.create({ data: { id, name } });
  await owner.user.create({ data: { id: admin.id, orgId, email: admin.email, name: admin.sub, googleSub: `g-${admin.sub}` } });
  // Added by email: no Google account bound yet, never signed in.
  await owner.user.create({ data: { id: invited.id, orgId, email: invited.email, name: "Invited Person", googleSub: null, lastSignInAt: null } });
  await owner.user.create({ data: { id: neverSignsIn.id, orgId, email: neverSignsIn.email, name: "Never Signs In", googleSub: null, lastSignInAt: null } });
  await asOrgAdmin(owner, (tx) => tx.workspace.create({ data: { id: ws, orgId, slug: `signin-${ws}`, name: "Sign-in", reportingCurrency: "USD" } }), orgId);
  await owner.roleAssignment.createMany({
    data: [
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: admin.id, role: "WORKSPACE_ADMIN", createdBy: admin.id },
      { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: invited.id, role: "VIEWER", createdBy: admin.id },
    ],
  });
  h = await startHarness();
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await h?.close();
  await deleteWorkspaceForTests(owner, ws, orgId);
  await owner.user.deleteMany({ where: { orgId: { in: [orgId, otherOrg] } } });
  await owner.organization.deleteMany({ where: { id: { in: [orgId, otherOrg] } } });
  await owner.$disconnect();
});

type Members = { users: Array<{ id: string; email: string; signedIn: boolean; lastSignInAt: string | null }> };

describe("sign-in status (round 11 PR 1)", () => {
  it("binds google_sub and stamps last_sign_in_at on the first Google sign-in; the Roles page clears 'Invited'", async () => {
    const requestId = `signin-${randomUUID()}`;
    // The token's sub differs from anything stored: this is an email match, not a sub match.
    const token = await h.mint({ sub: `new-${invited.sub}`, email: invited.email });
    const me = await h.call("GET", "/api/v1/me", token, { headers: { "x-request-id": requestId } });
    expect(me.status, JSON.stringify(me.body)).toBe(200);

    const row = await poll(() => owner.user.findUnique({ where: { id: invited.id } }));
    expect(row.googleSub).toBe(`g-new-${invited.sub}`);
    expect(row.lastSignInAt).not.toBeNull();

    const members = await h.call("GET", `/api/v1/workspaces/${ws}/members`, await h.mint(admin), { headers: { "x-workspace-id": ws } });
    const m = members.body as unknown as Members;
    const person = m.users.find((u) => u.id === invited.id);
    expect(person?.signedIn).toBe(true);
    expect(person?.lastSignInAt).not.toBeNull();

    const audited = await asOrgAdmin(owner, (tx) => tx.$queryRawUnsafe<Array<{ action: string }>>(`SELECT action FROM audit_event WHERE request_id = $1 ORDER BY occurred_at`, requestId), orgId);
    expect(audited.map((a) => a.action)).toEqual(["user.signed_in_first_time"]);
    const outboxRows = await asOrgAdmin(owner, (tx) => tx.$queryRawUnsafe<Array<{ topic: string }>>(`SELECT topic FROM outbox WHERE workspace_id = $1::uuid AND payload->>'userId' = $2`, ws, invited.id), orgId);
    expect(outboxRows.map((r) => r.topic)).toEqual(["access.changed"]);

    // A second call right away does not touch last_sign_in_at again (throttled).
    const first = (await owner.user.findUnique({ where: { id: invited.id } }))?.lastSignInAt;
    const me2 = await h.call("GET", "/api/v1/me", await h.mint({ sub: `new-${invited.sub}`, email: invited.email }, { googleSub: `g-new-${invited.sub}` }));
    expect(me2.status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    const second = (await owner.user.findUnique({ where: { id: invited.id } }))?.lastSignInAt;
    expect(second?.getTime()).toBe(first?.getTime());
  });

  it("a race binding the same google account id to two different email-matched users never throws (unique violation swallowed)", async () => {
    const rival = testUser("signin-rival", randomUUID());
    await owner.user.create({ data: { id: rival.id, orgId, email: rival.email, name: "Rival", googleSub: null, lastSignInAt: null } });
    const sharedSub = `g-shared-${randomUUID()}`;
    // Distinct `sub` (the throttle key) per user; the same `googleSub` is what both race to bind.
    const identityFor = (u: TestUser) => ({ sub: `throttle-${u.id}`, email: u.email, emailVerified: true, googleSub: sharedSub });
    const access = new AccessRepository(appDb());
    const userRefOf = async (u: TestUser) => (await owner.user.findUniqueOrThrow({ where: { id: u.id } })) as unknown as { id: string; orgId: string; email: string; name: string; isActive: boolean; googleSub: string | null; lastSignInAt: Date | null };
    await Promise.all([
      access.recordSignIn(identityFor(neverSignsIn), await userRefOf(neverSignsIn), `race-${randomUUID()}`),
      access.recordSignIn(identityFor(rival), await userRefOf(rival), `race-${randomUUID()}`),
    ]);
    const [a, b] = await Promise.all([owner.user.findUnique({ where: { id: neverSignsIn.id } }), owner.user.findUnique({ where: { id: rival.id } })]);
    // Exactly one of the two got the shared sub bound; the other's bookkeeping failure was swallowed.
    const bound = [a?.googleSub, b?.googleSub].filter((g) => g === sharedSub);
    expect(bound.length).toBe(1);
    await owner.roleAssignment.deleteMany({ where: { principalId: rival.id } });
    await owner.user.delete({ where: { id: rival.id } });
  });

  it("a non-unique-violation failure in app_record_sign_in is logged at error (not warn), and the login still succeeds", async () => {
    const errorSpy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    // A fake prisma whose transaction lets set_config through but fails the RPC call itself with a
    // plain error -- not a Prisma unique-constraint error (P2002) nor a raw-query P2010/23505, so
    // isUniqueViolation() must classify it as unexpected.
    const fakeTx = { $executeRawUnsafe: vi.fn((sql: string) => (sql.includes("app_record_sign_in") ? Promise.reject(new Error("connection reset")) : Promise.resolve())) };
    const fakePrisma = { $transaction: (fn: (tx: typeof fakeTx) => Promise<unknown>) => fn(fakeTx) } as unknown as PrismaClient;
    const access = new AccessRepository(fakePrisma);
    const requestId = `signin-${randomUUID()}`;
    const user = { id: invited.id, orgId, email: invited.email, name: "Invited Person", isActive: true, googleSub: null, lastSignInAt: null };

    await expect(access.recordSignIn({ sub: "broken-sub", email: invited.email, emailVerified: true, googleSub: null }, user, requestId)).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [payload, message] = errorSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toBe("recordSignIn failed");
    expect(payload).toMatchObject({ requestId, userId: invited.id });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("a Slack-vouched email (authenticateVerifiedEmail) is not a sign-in: last_sign_in_at stays null", async () => {
    const slackOnly = testUser("signin-slack", randomUUID());
    await owner.user.create({ data: { id: slackOnly.id, orgId, email: slackOnly.email, name: "Slack Only", googleSub: null, lastSignInAt: null } });
    await owner.roleAssignment.create({ data: { id: randomUUID(), workspaceId: ws, principalType: "user", principalId: slackOnly.id, role: "VIEWER", createdBy: admin.id } });
    const access = new AccessRepository(appDb());
    const deps = { access, cache: new MemoryRoleCache() };
    const auth = await authenticateVerifiedEmail(deps, { email: slackOnly.email, workspaceId: ws, requestId: `slack-${randomUUID()}` });
    expect(auth.user.email).toBe(slackOnly.email);
    const row = await owner.user.findUnique({ where: { id: slackOnly.id } });
    expect(row?.lastSignInAt).toBeNull();
    expect(row?.googleSub).toBeNull();
    await owner.roleAssignment.deleteMany({ where: { principalId: slackOnly.id } });
    await owner.user.delete({ where: { id: slackOnly.id } });
  });
});
