import { z } from "zod";
import { RoleEnum, ScopeFilter } from "./permissions.js";

/** POST /workspaces/:ws/roles. ORG_ADMIN is org-wide and not assignable per workspace. */
export const AssignRoleInput = z.object({
  principalType: z.enum(["user", "group"]),
  principalId: z.string().uuid(),
  role: RoleEnum.exclude(["ORG_ADMIN"]),
  scope: ScopeFilter.default({}),
});
export type AssignRoleInput = z.infer<typeof AssignRoleInput>;

/**
 * POST /workspaces/:ws/groups/sync. The payload a Directory API reader produces: the full member
 * list of each group. Members not listed are removed from that group.
 */
export const GroupsSyncInput = z.object({
  groups: z
    .array(
      z.object({
        googleGroup: z.string().email(),
        name: z.string().min(1),
        members: z.array(z.string().email()).max(10_000),
      }),
    )
    .min(1)
    .max(500),
});
export type GroupsSyncInput = z.infer<typeof GroupsSyncInput>;
