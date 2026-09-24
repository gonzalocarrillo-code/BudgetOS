import { DomainError, GroupsSyncInput, newId } from "@budget/domain";
import { audit, outbox, withTenant } from "@budget/db";
import type { PrismaClient } from "@prisma/client";
import { parseInput, requireWorkspace } from "../../../common/parse-input.js";
import type { AuthContext } from "../../../common/tenant.js";

/**
 * POST /workspaces/:ws/groups/sync (plan §7.4). Takes the full member list per group, as the
 * Directory API reader will produce it, and makes app_group_member match. Groups are org-wide, so
 * a group that grants roles in another workspace can only be synced by an org admin.
 */
export async function syncGroups(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const input = parseInput(GroupsSyncInput, raw);
  const workspaceId = requireWorkspace(auth.ctx.workspaceId);
  const orgId = auth.user.orgId;
  return withTenant(prisma, auth.ctx, async (tx) => {
    const results: Array<{ groupId: string; googleGroup: string; added: number; removed: number; members: number }> = [];
    const unknownMembers = new Set<string>();
    for (const g of input.groups) {
      const googleGroup = g.googleGroup.toLowerCase();
      const existing = await tx.group.findUnique({ where: { orgId_googleGroup: { orgId, googleGroup } } });
      if (existing !== null && !auth.isOrgAdmin) {
        const elsewhere = await tx.roleAssignment.findFirst({
          where: { principalType: "group", principalId: existing.id, OR: [{ workspaceId: null }, { workspaceId: { not: workspaceId } }] },
          select: { id: true },
        });
        if (elsewhere !== null) {
          throw new DomainError("FORBIDDEN", "Group grants roles outside this workspace; an org admin must sync it", { googleGroup });
        }
      }
      const group =
        existing === null
          ? await tx.group.create({ data: { id: newId(), orgId, googleGroup, name: g.name } })
          : await tx.group.update({ where: { id: existing.id }, data: { name: g.name } });
      const emails = [...new Set(g.members.map((m) => m.toLowerCase()))];
      const users = await tx.user.findMany({ where: { orgId, email: { in: emails } }, select: { id: true, email: true } });
      const found = new Set(users.map((u) => u.email));
      for (const e of emails) if (!found.has(e)) unknownMembers.add(e);
      const wanted = users.map((u) => u.id);
      const current = new Set((await tx.groupMember.findMany({ where: { groupId: group.id }, select: { userId: true } })).map((m) => m.userId));
      const toAdd = wanted.filter((id) => !current.has(id));
      if (toAdd.length) await tx.groupMember.createMany({ data: toAdd.map((userId) => ({ groupId: group.id, userId })) });
      const removed = await tx.groupMember.deleteMany({ where: { groupId: group.id, userId: { notIn: wanted } } });
      await tx.groupMember.updateMany({ where: { groupId: group.id }, data: { syncedAt: new Date() } });
      results.push({ groupId: group.id, googleGroup, added: toAdd.length, removed: removed.count, members: wanted.length });
    }
    const after = { groups: results, unknownMembers: [...unknownMembers].sort() };
    await audit(tx, {
      workspaceId,
      actorId: auth.user.id,
      actorType: auth.ctx.actorType,
      action: "groups.synced",
      entityType: "workspace",
      entityId: workspaceId,
      after,
      requestId: auth.ctx.requestId,
    });
    await outbox(tx, { workspaceId, topic: "access.changed", payload: { kind: "groups.synced", groupIds: results.map((r) => r.groupId) } });
    return after;
  });
}
