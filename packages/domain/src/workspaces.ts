import { z } from "zod";
import { RoleEnum, ScopeFilter } from "./permissions.js";

/**
 * Workspace lifecycle and the org console (ADR-052, docs/UX_AUDIT_AND_ADMIN_PLAN.md Part 3). Only
 * superadmins (the org-wide ORG_ADMIN role) create, archive, restore and delete workspaces.
 */
export const WorkspaceStatus = z.enum(["ACTIVE", "ARCHIVED"]);
export type WorkspaceStatus = z.infer<typeof WorkspaceStatus>;

/** PATCH /workspaces/:ws — archive or restore. */
export const UpdateWorkspaceStatusInput = z.object({ status: WorkspaceStatus, reason: z.string().trim().max(500).optional() });
export type UpdateWorkspaceStatusInput = z.infer<typeof UpdateWorkspaceStatusInput>;

/** DELETE /workspaces/:ws — an archived workspace, its exact name typed, and why. */
export const DeleteWorkspaceInput = z.object({ confirmName: z.string().min(1).max(120), reason: z.string().trim().min(1).max(500) });
export type DeleteWorkspaceInput = z.infer<typeof DeleteWorkspaceInput>;

const Person = z.object({ id: z.string().uuid(), name: z.string(), email: z.string() });

/** GET /workspaces — every workspace of the org, for the org console. */
export const OrgWorkspace = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  currency: z.string(),
  fiscalYearStartMonth: z.number().int(),
  status: WorkspaceStatus,
  archivedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  purgeAfter: z.string().nullable(),
  createdAt: z.string(),
  members: z.number().int(),
  budgets: z.number().int(),
  lastActivityAt: z.string().nullable(),
  admins: z.array(Person),
});
export type OrgWorkspace = z.infer<typeof OrgWorkspace>;
export const OrgWorkspacesResponse = z.object({ workspaces: z.array(OrgWorkspace) });
export type OrgWorkspacesResponse = z.infer<typeof OrgWorkspacesResponse>;

/** GET /org/people — the org directory: each person, where they have roles, and whether active. */
export const OrgPerson = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string(),
  isActive: z.boolean(),
  signedIn: z.boolean(),
  lastSignInAt: z.string().nullable(),
  superadmin: z.boolean(),
  /** S-14 (ADR-075): the Slack user id this person is pinned to, or null if never linked. */
  slackUserId: z.string().nullable(),
  workspaces: z.array(z.object({ workspaceId: z.string().uuid(), name: z.string(), roles: z.array(z.string()) })),
});
export type OrgPerson = z.infer<typeof OrgPerson>;
export const OrgPeopleResponse = z.object({ people: z.array(OrgPerson) });
export type OrgPeopleResponse = z.infer<typeof OrgPeopleResponse>;

/**
 * PATCH /org/people/:id — deactivate or reactivate someone (a superadmin cannot deactivate
 * themselves), or clear their pinned Slack identity (S-14, ADR-075) so they can relink a replaced
 * Slack account. At least one of the two.
 */
export const UpdateOrgPersonInput = z
  .object({ isActive: z.boolean().optional(), slackUserId: z.null().optional() })
  .refine((v) => v.isActive !== undefined || v.slackUserId !== undefined, { message: "Provide isActive or slackUserId" });
export type UpdateOrgPersonInput = z.infer<typeof UpdateOrgPersonInput>;

/**
 * POST /workspaces/:ws/members — a workspace admin adds someone to their workspace by work email,
 * with a role here (ORG-005). The person joins the org if they are new to it; nobody else's
 * workspaces are touched or shown.
 */
export const AddMemberInput = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  name: z.string().trim().min(1).max(200),
  role: RoleEnum.exclude(["ORG_ADMIN"]).optional(),
  scope: ScopeFilter.default({}),
});
export type AddMemberInput = z.infer<typeof AddMemberInput>;
