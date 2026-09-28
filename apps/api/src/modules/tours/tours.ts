import { CompleteTourInput, DomainError, ListToursQuery, TourStep, UpdateTourInput, newId, tourRolesFor, type TourRole } from "@budget/domain";
import { audit, ensureDefaultTours, outbox, withTenant, type Tx } from "@budget/db";
import type { Prisma, PrismaClient, Tour } from "@prisma/client";
import { z } from "zod";
import { parseId, parseInput, requireWorkspace } from "../../common/parse-input.js";
import { orgAdminCtx, type AuthContext } from "../../common/tenant.js";

/**
 * Guided tours (spec §27, plan §11.7). A role's tour is the workspace's own row, else the built-in
 * default (workspace_id NULL). GET /tours returns the caller's tours not completed at their current
 * version (or every tour with `all=true`, for Help and the admin page); POST complete records it.
 * Org admins edit a workspace's tour: editing a default creates the workspace's copy; each edit is
 * a new version, so everyone sees it again.
 */

const json = (v: unknown) => v as Prisma.InputJsonValue;
const Steps = z.array(TourStep);

/** `completed`: finished at the current version; `dismissed`: closed early at it (UX-001), so not offered again. */
export function tourView(t: Tour, completedVersion: number | null, dismissedVersion: number | null = null) {
  const steps = Steps.safeParse(t.steps);
  const completed = completedVersion !== null && completedVersion >= t.version;
  return { id: t.id, workspaceId: t.workspaceId, role: t.role as TourRole, name: t.name, steps: steps.success ? steps.data : [], version: t.version, completed, dismissed: !completed && dismissedVersion !== null && dismissedVersion >= t.version, isDefault: t.workspaceId === null };
}

/** The effective tour per role for a workspace: its own row, else the default. */
async function effectiveTours(tx: Tx, workspaceId: string): Promise<Map<string, Tour>> {
  const rows = await tx.tour.findMany({ where: { OR: [{ workspaceId }, { workspaceId: null }] } });
  const out = new Map<string, Tour>();
  for (const r of rows.filter((x) => x.workspaceId === null)) out.set(r.role, r);
  for (const r of rows.filter((x) => x.workspaceId !== null)) out.set(r.role, r);
  return out;
}

/** GET /tours?role=&all= (workspace from X-Workspace-Id). Without `role`, the tours the caller's roles call for. */
export async function listTours(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const q = parseInput(ListToursQuery, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const roles: TourRole[] = q.role ? [q.role] : q.all === "true" && auth.isOrgAdmin ? ["planner", "approver", "finance", "data_admin"] : tourRolesFor(auth.roles);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const tours = await effectiveTours(tx, workspaceId);
    const picked = roles.flatMap((r) => (tours.has(r) ? [tours.get(r) as Tour] : []));
    const done = await tx.tourCompletion.findMany({ where: { userId: auth.user.id, tourId: { in: picked.map((t) => t.id) } } });
    const best = new Map<string, number>();
    const skipped = new Map<string, number>();
    for (const d of done) {
      const into = d.dismissed ? skipped : best;
      into.set(d.tourId, Math.max(into.get(d.tourId) ?? 0, d.version));
    }
    return picked.map((t) => tourView(t, best.get(t.id) ?? null, skipped.get(t.id) ?? null)).filter((t) => q.all === "true" || (!t.completed && !t.dismissed));
  });
}

/** POST /tours/:id/complete { version } — idempotent; the caller's own row (RLS). */
export async function completeTour(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  const id = parseId(rawId);
  const input = parseInput(CompleteTourInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, auth.ctx, async (tx) => {
    const t = await tx.tour.findUnique({ where: { id } });
    if (t === null) throw new DomainError("NOT_FOUND", "Tour not found");
    if (input.version > t.version) throw new DomainError("VALIDATION", "That version of the tour does not exist", { version: t.version });
    const key = { userId_tourId_version: { userId: auth.user.id, tourId: id, version: input.version } };
    // A finish after a skip turns the row into a completion; a skip never undoes a completion.
    await tx.tourCompletion.upsert({ where: key, create: { userId: auth.user.id, tourId: id, version: input.version, dismissed: input.dismissed }, update: input.dismissed ? {} : { dismissed: false, completedAt: new Date() } });
    const action = input.dismissed ? "tour.dismissed" : "tour.completed";
    await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action, entityType: "tour", entityId: id, after: { role: t.role, version: input.version }, requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId, topic: action, payload: { tourId: id, role: t.role, version: input.version, userId: auth.user.id } });
    return { tourId: id, version: input.version, completed: !input.dismissed && input.version >= t.version, dismissed: input.dismissed };
  });
}

/** PATCH /tours/:id (org admins) — a default becomes the workspace's own copy; a new version either way. */
export async function updateTour(prisma: PrismaClient, auth: AuthContext, rawId: string, raw: unknown) {
  if (!auth.isOrgAdmin) throw new DomainError("FORBIDDEN", "Only an org admin edits tours");
  const id = parseId(rawId);
  const input = parseInput(UpdateTourInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  return withTenant(prisma, orgAdminCtx(auth), async (tx) => {
    const t = await tx.tour.findUnique({ where: { id } });
    if (t === null || (t.workspaceId !== null && t.workspaceId !== workspaceId)) throw new DomainError("NOT_FOUND", "Tour not found");
    const data = { ...(input.name ? { name: input.name } : {}), ...(input.steps ? { steps: json(input.steps) } : {}), updatedAt: new Date() };
    const saved =
      t.workspaceId === null
        ? await tx.tour.upsert({
            where: { id: (await tx.tour.findFirst({ where: { workspaceId, role: t.role }, select: { id: true } }))?.id ?? newId() },
            create: { id: newId(), workspaceId, role: t.role, name: input.name ?? t.name, steps: json(input.steps ?? t.steps), version: t.version + 1 },
            update: { ...data, version: { increment: 1 } },
          })
        : await tx.tour.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
    await audit(tx, { workspaceId, actorId: auth.user.id, actorType: auth.ctx.actorType, action: "tour.updated", entityType: "tour", entityId: saved.id, before: tourView(t, null), after: tourView(saved, null), requestId: auth.ctx.requestId });
    await outbox(tx, { workspaceId, topic: "tour.changed", payload: { tourId: saved.id, role: saved.role, version: saved.version } });
    return tourView(saved, null);
  });
}

/** Writes the built-in tours when missing or changed (org-admin bypass): the admin page and the golden seed call it. */
export async function syncDefaultTours(prisma: PrismaClient, auth: AuthContext): Promise<number> {
  if (!auth.isOrgAdmin) return 0;
  return withTenant(prisma, orgAdminCtx(auth), (tx) => ensureDefaultTours(tx, newId));
}
