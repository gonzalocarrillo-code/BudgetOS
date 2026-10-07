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

/** POST /workspaces/:ws/members: add a person to the org by email; they sign in with Google later. */
export const AddPersonInput = z.object({ email: z.string().trim().toLowerCase().email().max(320), name: z.string().trim().min(1).max(200) });
export type AddPersonInput = z.infer<typeof AddPersonInput>;

/** GET /workspaces/:ws/members: the org's people and groups, each with its role assignments in this workspace. */
const Assignment = z.object({ id: z.string().uuid(), role: z.string(), scope: z.unknown() });
export const PeopleResponse = z.object({
  users: z.array(z.object({ id: z.string().uuid(), email: z.string(), name: z.string(), isActive: z.boolean(), signedIn: z.boolean(), lastSignInAt: z.string().nullable(), orgAdmin: z.boolean(), roles: z.array(Assignment) })),
  groups: z.array(z.object({ id: z.string().uuid(), name: z.string(), googleGroup: z.string(), memberCount: z.number().int(), roles: z.array(Assignment) })),
});
export type PeopleResponse = z.infer<typeof PeopleResponse>;
