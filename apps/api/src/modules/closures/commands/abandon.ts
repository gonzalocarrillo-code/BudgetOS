import { CLOSURE_STALE_MINUTES, DomainError } from "@budget/domain";
import { lockClosure, withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseId } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";
import { closureView } from "../views.js";
import { failClosure } from "./fail-closure.js";

/**
 * POST /closures/:id/abandon (W3-1, ADR-018 addendum; `closure.close`): a close whose process died
 * between its two transactions stays `closing`, holding its envelopes' locks. Once it is older than
 * CLOSURE_STALE_MINUTES it can be abandoned: it becomes `failed` and its locks are released. If the
 * original request is still alive and finishes writing later, it finds the closure failed and
 * returns 409 instead of closing it.
 */
export async function abandonClosure(prisma: PrismaClient, auth: AuthContext, rawId: string, now: Date = new Date()) {
  const id = parseId(rawId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    if (!(await lockClosure(tx, id))) throw new DomainError("NOT_FOUND", "Closure not found");
    const current = await tx.periodClosure.findUniqueOrThrow({ where: { id } });
    if (current.status !== "closing") throw new DomainError("CONFLICT", `Only a close in progress can be abandoned; this closure is ${current.status}`, { status: current.status });
    const staleAt = new Date(current.closedAt.getTime() + CLOSURE_STALE_MINUTES * 60_000);
    if (now < staleAt) {
      throw new DomainError("CONFLICT", `This close started at ${current.closedAt.toISOString()} and is still in progress; it can be abandoned from ${staleAt.toISOString()}`, { startedAt: current.closedAt.toISOString(), staleAt: staleAt.toISOString() });
    }
    const minutes = Math.floor((now.getTime() - current.closedAt.getTime()) / 60_000);
    const { saved, period } = await failClosure(tx, auth, current, `Abandoned by ${auth.user.name || auth.user.email} after ${minutes} minutes in progress`, "closure.abandoned");
    return closureView(saved, period, await tx.closureEnvelope.count({ where: { closureId: id } }));
  });
}
