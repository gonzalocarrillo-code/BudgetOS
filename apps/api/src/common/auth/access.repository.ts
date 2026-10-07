import { ScopeFilter, type Role, type ScopedRole } from "@budget/domain";
import { withIdentity, withTenant } from "@budget/db";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import { recordFirstSignIn } from "./first-sign-in.js";
import type { VerifiedIdentity } from "./jwt-verifier.js";
import type { WorkspaceAccess } from "./role-cache.js";

/**
 * The one expected race in recordSignIn: two identities binding the same `google_sub`
 * concurrently. P2002 is Prisma's own unique-constraint error; P2010 is a raw query's failure,
 * whose real reason is `meta.code` (all-exceptions.filter.ts's PG_CODE map uses the same shape) --
 * here that's Postgres's 23505 (unique_violation) raised inside app_record_sign_in's UPDATE.
 */
function isUniqueViolation(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (e.code === "P2002") return true;
  if (e.code === "P2010") return (e.meta as { code?: unknown } | null)?.code === "23505";
  return false;
}

export interface AppUserRef {
  id: string;
  orgId: string;
  email: string;
  name: string;
  isActive: boolean;
  googleSub: string | null;
  lastSignInAt: Date | null;
}

/**
 * Identity and role lookups. `findUser` runs in withIdentity(), which exposes only the app_user
 * matching the verified token. The org is known after that, so the other lookups run in
 * withTenant() with the user's org (migrations 20260924020000 to 20260924040000).
 */
@Injectable()
export class AccessRepository {
  private readonly logger = new Logger(AccessRepository.name);
  // Round 11 (PR 1): in-process throttle so recordSignIn doesn't open a transaction on every
  // request once a user is already bound and recently seen. Keyed by app_user id.
  private readonly lastRecorded = new Map<string, number>();

  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  /** Match on the Google account id or Identity Platform uid, else on a verified email. */
  async findUser(identity: VerifiedIdentity): Promise<AppUserRef | null> {
    const subs = [identity.sub, ...(identity.googleSub ? [identity.googleSub] : [])];
    const email = identity.emailVerified ? identity.email : null;
    return withIdentity(this.prisma, { subs, email }, async (tx) => {
      const bySub = await tx.user.findFirst({ where: { googleSub: { in: subs } } });
      if (bySub) return bySub;
      if (email === null) return null;
      return tx.user.findUnique({ where: { email } });
    });
  }

  /**
   * Round 11 (PR 1): remember the sign-in (at most every 15 min per identity) and bind the
   * account id on the first email-matched sign-in, so later sign-ins match by id and "Not signed
   * in yet" clears. `user` is the pre-call row from `findUser`, used only to decide whether this
   * is the first bind (for the audit row) and which org/request to audit it under. Bookkeeping
   * only: a failure here never blocks the request.
   */
  async recordSignIn(identity: VerifiedIdentity, user: AppUserRef, requestId: string): Promise<void> {
    const now = Date.now();
    const last = this.lastRecorded.get(identity.sub);
    if (last !== undefined && now - last < 15 * 60_000) return;
    this.lastRecorded.set(identity.sub, now);
    const subs = [identity.sub, ...(identity.googleSub ? [identity.googleSub] : [])];
    const email = identity.emailVerified ? identity.email : null;
    const sub = identity.googleSub ?? identity.sub;
    const wasFirstBind = user.googleSub === null;
    try {
      await withIdentity(this.prisma, { subs, email }, (tx) => tx.$executeRawUnsafe(`SELECT app_record_sign_in($1)`, sub));
    } catch (e) {
      // google_sub is UNIQUE: if another row already owns it, the UPDATE in app_record_sign_in
      // raises 23505 (surfaced through a raw query as Prisma's P2010 with meta.code "23505", or
      // directly as P2002 off a non-raw path) -- an expected, harmless race, logged at warn. Never
      // block a login on bookkeeping, but anything else here is a broken bookkeeping path and must
      // not hide as a warning.
      if (isUniqueViolation(e)) this.logger.warn({ err: e, requestId, userId: user.id }, "recordSignIn failed");
      else this.logger.error({ err: e, requestId, userId: user.id }, "recordSignIn failed");
      return;
    }
    if (wasFirstBind) {
      try {
        await recordFirstSignIn(this.prisma, user, requestId);
      } catch (e) {
        this.logger.error({ err: e, requestId, userId: user.id }, "recordFirstSignIn audit failed");
      }
    }
  }

  /** The workspace's org, or null when it does not exist or belongs to another org (RLS hides it). */
  async workspaceOrg(workspaceId: string, user: { id: string; orgId: string }, requestId: string): Promise<string | null> {
    return (await this.workspaceInfo(workspaceId, user, requestId))?.orgId ?? null;
  }

  /** The workspace's org and lifecycle (ADR-052), or null when it is not visible. */
  async workspaceInfo(workspaceId: string, user: { id: string; orgId: string }, requestId: string): Promise<{ orgId: string; status: string; deleted: boolean } | null> {
    const ctx = { workspaceId: null, orgId: user.orgId, userId: user.id, isOrgAdmin: false, actorType: "user" as const, requestId };
    const ws = await withTenant(this.prisma, ctx, (tx) => tx.workspace.findUnique({ where: { id: workspaceId }, select: { orgId: true, status: true, deletedAt: true } }));
    return ws ? { orgId: ws.orgId, status: ws.status, deleted: ws.deletedAt !== null } : null;
  }

  /** Assignments for the user in `workspaceId` (or org-wide only when null), including via groups. */
  async access(
    user: { id: string; orgId: string },
    workspaceId: string | null,
    requestId: string,
  ): Promise<WorkspaceAccess> {
    const userId = user.id;
    const ctx = { workspaceId, orgId: user.orgId, userId, isOrgAdmin: false, actorType: "user" as const, requestId };
    const rows = await withTenant(this.prisma, ctx, async (tx) => {
      const groups = await tx.groupMember.findMany({ where: { userId }, select: { groupId: true } });
      return tx.roleAssignment.findMany({
        where: {
          AND: [
            {
              OR: [
                { principalType: "user", principalId: userId },
                { principalType: "group", principalId: { in: groups.map((g) => g.groupId) } },
              ],
            },
            { OR: [{ workspaceId: null }, ...(workspaceId ? [{ workspaceId }] : [])] },
          ],
        },
      });
    });
    const assignments: ScopedRole[] = [];
    let isOrgAdmin = false;
    for (const row of rows) {
      // Only ORG_ADMIN is meaningful org-wide; any other role needs a workspace.
      if (row.workspaceId === null && row.role !== "ORG_ADMIN") continue;
      if (row.role === "ORG_ADMIN") isOrgAdmin = true;
      const scope = ScopeFilter.safeParse(row.scope);
      // An unreadable scope grants nothing rather than everything.
      if (!scope.success) continue;
      assignments.push({ role: row.role as Role, scope: scope.data });
    }
    return { isOrgAdmin, assignments };
  }
}
