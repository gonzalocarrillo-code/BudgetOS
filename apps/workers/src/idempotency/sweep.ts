import { localAllOrgs, sweepIdempotencyKeys, withTenant, type LocalScope, type RawReader } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { log } from "../log.js";

/**
 * W3-2 (ADR-0081): `Idempotency-Key` rows live 24 h. Once a day the worker deletes every org's
 * expired rows, as the app role in an org-wide session (RLS shows the org's workspaces and its
 * org-level rows; Slack-team rows are swept by their own next claim). A claim already ignores its
 * own key's expired row, so this only keeps the table small.
 */
export async function idempotencySweep(app: PrismaClient, orgIds: string[]): Promise<number> {
  let removed = 0;
  for (const orgId of orgIds) {
    removed += await withTenant(app, { workspaceId: null, orgId, userId: null, isOrgAdmin: true, actorType: "system", requestId: `idempotency-sweep-${orgId}` }, (tx) => sweepIdempotencyKeys(tx));
  }
  return removed;
}

let lastSweep = 0;
/** The local runner's daily pass: discovers its orgs as budget_publisher, sweeps as budget_app. */
export async function idempotencyPass(app: PrismaClient, publisher: RawReader, scope: LocalScope, now: number = Date.now()): Promise<void> {
  if (now - lastSweep < 86_400_000) return;
  lastSweep = now;
  const orgs = await localAllOrgs(publisher, scope);
  if (orgs.length === 0) return;
  const removed = await idempotencySweep(app, orgs);
  log.info({ orgs: orgs.length, removed }, "idempotency key sweep finished");
}
