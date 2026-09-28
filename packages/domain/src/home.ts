import { z } from "zod";
import { FilterGroup } from "./filter-ast.js";
import type { Role } from "./permissions.js";

/**
 * Home, guided tours and workspace templates (spec §27, plan §11.7).
 */

// ---- Tours ------------------------------------------------------------------------------------

export const TourRole = z.enum(["planner", "approver", "finance", "data_admin"]);
export type TourRole = z.infer<typeof TourRole>;

/** One step: where it runs (`path` under /w/:ws, e.g. "/budgets"), what it points at, what it says. */
export const TourStep = z.object({
  path: z.string().regex(/^\/[a-z0-9/_-]*$/i).optional(),
  element: z.string().regex(/^\[data-tour="[a-z0-9-]+"\]$/, 'element is a [data-tour="…"] selector'),
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(600),
});
export type TourStep = z.infer<typeof TourStep>;

/** GET /tours?role= */
export const ListToursQuery = z.object({ role: TourRole.optional(), all: z.enum(["true", "false"]).optional() });
export type ListToursQuery = z.infer<typeof ListToursQuery>;

/** PATCH /tours/:id (org admins): new steps or name; a new version, so everyone sees it again. */
export const UpdateTourInput = z
  .object({ name: z.string().min(1).max(120).optional(), steps: z.array(TourStep).min(1).max(12).optional() })
  .refine((v) => v.name !== undefined || v.steps !== undefined, { message: "Nothing to update" });
export type UpdateTourInput = z.infer<typeof UpdateTourInput>;

/** POST /tours/:id/complete — the version the user saw. */
/** POST /tours/:id/complete: `dismissed` when the person closed it before the last step (UX-001). */
export const CompleteTourInput = z.object({ version: z.number().int().min(1), dismissed: z.boolean().default(false) });
export type CompleteTourInput = z.infer<typeof CompleteTourInput>;

/** The tour a user's roles call for: builders and budget owners plan, approvers approve, finance closes, data admins load. */
export function tourRolesFor(roles: readonly Role[]): TourRole[] {
  const out = new Set<TourRole>();
  for (const r of roles) {
    if (r === "PLANNER" || r === "BUDGET_OWNER") out.add("planner");
    if (r === "APPROVER" || r === "BUDGET_OWNER") out.add("approver");
    if (r === "FINANCE") out.add("finance");
    if (r === "DATA_ADMIN") out.add("data_admin");
  }
  return [...out];
}

// ---- Workspace templates ------------------------------------------------------------------------

/** POST /workspaces (org admins): a workspace from a template, optionally with the demo dataset. */
export const CreateWorkspaceInput = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/).optional(),
  templateId: z.string().uuid(),
  withDemoData: z.boolean().default(false),
  reportingCurrency: z.string().regex(/^[A-Z]{3}$/).default("USD"),
  fiscalYearStartMonth: z.number().int().min(1).max(12).default(1),
  /** ADR-052: the workspace's first admin, by work email (created in the org when new). */
  firstAdmin: z.object({ email: z.string().trim().toLowerCase().email().max(320), name: z.string().trim().min(1).max(200) }).optional(),
});
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceInput>;

/** A saved view a template creates (shared with the workspace). */
export const TemplateSavedView = z.object({ name: z.string().min(1).max(120), screen: z.string().min(1).max(40), definition: z.record(z.string(), z.unknown()) });

// ---- Home ---------------------------------------------------------------------------------------

export const HomeScope = z.object({
  label: z.string(),
  filter: FilterGroup,
  /** The top-level budget this strip is (UX-008): its own row in the budget structure. */
  envelopeId: z.string().uuid().optional(),
  budget: z.string().nullable(),
  actual: z.string().nullable(),
  projected: z.string().nullable(),
  paceIndex: z.string().nullable(),
  spentPct: z.string().nullable(),
});
export type HomeScope = z.infer<typeof HomeScope>;

export const HomeResponse = z.object({
  waitingOnMe: z.object({
    approvals: z.array(z.object({ id: z.string().uuid(), summary: z.string().nullable(), entityType: z.string(), requestedAt: z.string(), dueAt: z.string().nullable() }).passthrough()),
    mentions: z.array(z.object({ commentId: z.string().uuid(), threadId: z.string().uuid(), anchorType: z.string(), anchorId: z.string().uuid(), body: z.string(), author: z.string().nullable(), createdAt: z.string() })),
    alerts: z.array(z.object({ id: z.string().uuid(), envelopeId: z.string().uuid(), envelopeName: z.string(), severity: z.string(), openedAt: z.string() })),
    unmatched: z.number().int(),
  }),
  scopes: z.array(HomeScope),
  recents: z.array(z.object({ entityType: z.string(), entityId: z.string().uuid(), title: z.string(), at: z.string() })),
  pinnedViews: z.array(z.object({ id: z.string().uuid(), name: z.string(), screen: z.string(), definition: z.record(z.string(), z.unknown()) })),
  /** The workspace and its fiscal year so far (Home's header). */
  workspace: z.object({ name: z.string(), currency: z.string(), period: z.object({ start: z.string(), end: z.string(), elapsed: z.string().nullable() }) }).optional(),
  /** This fiscal year over the budgets the caller may read; null when there are none. */
  totals: z.object({ budget: z.string().nullable(), actual: z.string().nullable(), spentPct: z.string().nullable(), openAlerts: z.number().int() }).nullable().optional(),
  /** What the workspace has set up (Home's getting-started steps). */
  setup: z.object({ budgets: z.number().int(), sources: z.number().int(), people: z.number().int(), spend: z.boolean(), tags: z.number().int() }).optional(),
});
export type HomeResponse = z.infer<typeof HomeResponse>;

/** PATCH /me: the caller's own display name (what Home greets them by). */
export const UpdateMeInput = z.object({ name: z.string().trim().min(1).max(120) });
export type UpdateMeInput = z.infer<typeof UpdateMeInput>;

/** PATCH /workspaces/:ws/general: the workspace's name (Settings › Workspace). */
export const UpdateWorkspaceInput = z.object({ name: z.string().trim().min(1).max(120) });
export type UpdateWorkspaceInput = z.infer<typeof UpdateWorkspaceInput>;
