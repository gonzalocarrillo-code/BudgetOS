import { z } from "zod";
import { FilterGroup } from "./filter-ast.js";
import { DataAsOfView } from "./overview.js";
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
/** POST /workspaces/:ws/demo-data/purge (I-3): a destructive action with no undo needs saying so. */
export const PurgeDemoInput = z.object({ confirm: z.literal(true) });
export type PurgeDemoInput = z.infer<typeof PurgeDemoInput>;

/**
 * GET /workspaces/:ws/demo-data (HF-1, audit T-5 follow-up): demo rows left, whether the workspace
 * has real (non-demo) budgets too, and — new — `hidden`: the planner excludes demo money from every
 * total by default once a real budget exists (T-5), so `hidden` is true exactly when that exclusion
 * is silently dropping rows the workspace still has. The web banners and the Slack context line both
 * key off this one field instead of recomputing `envelopes > 0 && hasRealBudgets` themselves.
 */
export const DemoDataResponse = z.object({ envelopes: z.number().int().min(0), targets: z.number().int().min(0), hasRealBudgets: z.boolean(), hidden: z.boolean(), hasCampaignData: z.boolean() });
export type DemoDataResponse = z.infer<typeof DemoDataResponse>;

/** POST /workspaces/:ws/demo-data/campaigns (EX-3, org admins): no body — idempotent by itself. */
export const AddCampaignDemoDataResponse = z.object({ alreadyPresent: z.boolean(), campaigns: z.number().int().min(0), facts: z.number().int().min(0), supersededFacts: z.number().int().min(0), experiments: z.number().int().min(0) });
export type AddCampaignDemoDataResponse = z.infer<typeof AddCampaignDemoDataResponse>;

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
  /** HO-005: what is left, whether the caller owns it, and what is open under it. */
  remaining: z.string().nullable().optional(),
  owner: z.boolean().optional(),
  alerts: z.number().int().optional(),
  pending: z.number().int().optional(),
});
export type HomeScope = z.infer<typeof HomeScope>;

/**
 * An approval request on Home (HO-005): a readable title (the budget, or the bulk change's
 * rationale), how many budgets it changes, and the approved total before and after, in the
 * reporting currency (null when it is not money: a target, a batch of results).
 */
export const HomeRequestCard = z.object({
  title: z.string(),
  count: z.number().int(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  /** (after − before) ÷ before; null for a new budget or when it is not money. */
  changePct: z.string().nullable().optional(),
});

/**
 * Open alerts on budgets that are the caller's, per top-level budget (HO-005): how many, how many
 * assigned to them, the most severe, and the count per rule.
 */
export const HomeAlertGroup = z.object({
  envelopeId: z.string().uuid(),
  name: z.string(),
  severity: z.string(),
  count: z.number().int(),
  /** Of these, assigned to the caller. */
  assigned: z.number().int(),
  rules: z.array(z.object({ ruleId: z.string().uuid(), ruleName: z.string().nullable(), severity: z.string(), count: z.number().int() })),
});
export type HomeAlertGroup = z.infer<typeof HomeAlertGroup>;

export const HomeResponse = z.object({
  waitingOnMe: z.object({
    approvals: z.array(z.object({ id: z.string().uuid(), summary: z.string().nullable(), entityType: z.string(), requestedAt: z.string(), dueAt: z.string().nullable(), requestedByName: z.string().nullable().optional() }).merge(HomeRequestCard.partial()).passthrough()),
    mentions: z.array(z.object({ commentId: z.string().uuid(), threadId: z.string().uuid(), anchorType: z.string(), anchorId: z.string().uuid(), body: z.string(), author: z.string().nullable(), createdAt: z.string() })),
    alerts: z.array(z.object({ id: z.string().uuid(), envelopeId: z.string().uuid(), envelopeName: z.string(), severity: z.string(), openedAt: z.string() })),
    /** Unmatched spend rows, for callers who can map them (source.manage); 0 otherwise. */
    unmatched: z.number().int(),
    canMap: z.boolean().optional(),
    /** Drafts the caller saved and never sent for approval. */
    drafts: z.object({ count: z.number().int(), items: z.array(z.object({ envelopeId: z.string().uuid(), versionId: z.string().uuid(), name: z.string(), createdAt: z.string() })) }).optional(),
    alertsOnMyBudgets: z.array(HomeAlertGroup).optional(),
    /** For callers who close periods: periods ending soon, or ended lately, not closed yet. */
    closures: z.array(z.object({ periodKey: z.string(), start: z.string(), end: z.string(), daysLeft: z.number().int(), drafts: z.number().int(), pending: z.number().int() })).optional(),
    /** For callers who manage sources: active sources whose last run failed this week. */
    failedRuns: z.array(z.object({ sourceId: z.string().uuid(), sourceName: z.string(), at: z.string(), error: z.string().nullable() })).optional(),
  }),
  /** The caller's own requests still waiting on someone. */
  sent: z.array(z.object({ id: z.string().uuid(), summary: z.string().nullable(), entityType: z.string(), requestedAt: z.string(), dueAt: z.string().nullable(), waitingOn: z.string().nullable() }).merge(HomeRequestCard)).optional(),
  scopes: z.array(HomeScope),
  /** What the caller did last, one row per thing: what it is, where it sits, and what they did. */
  recents: z.array(z.object({ entityType: z.string(), entityId: z.string().uuid(), title: z.string(), at: z.string(), action: z.string().optional(), parent: z.string().nullable().optional() })),
  pinnedViews: z.array(z.object({ id: z.string().uuid(), name: z.string(), screen: z.string(), definition: z.record(z.string(), z.unknown()) })),
  /** The workspace and its fiscal year so far (Home's header). */
  workspace: z.object({ name: z.string(), currency: z.string(), period: z.object({ start: z.string(), end: z.string(), elapsed: z.string().nullable() }) }).optional(),
  /**
   * This fiscal year over the budgets the caller may read, as the Overview's headline counts it
   * (Home's pulse); null when there are none. `waiting` and `overdue`: approval requests open in the
   * workspace the caller may read.
   */
  totals: z.object({ budget: z.string().nullable(), actual: z.string().nullable(), spentPct: z.string().nullable(), paceIndex: z.string().nullable().optional(), openAlerts: z.number().int(), waiting: z.number().int().optional(), overdue: z.number().int().optional() }).nullable().optional(),
  /** HO-003: how current the actuals are; `elapsed` is the fiscal year gone by then (pace counts to it). */
  asOf: DataAsOfView.extend({ elapsed: z.string().nullable() }).optional(),
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

// ---- Notifications (DS-003) -------------------------------------------------------------------

export const NotificationItem = z.object({ id: z.string().uuid(), kind: z.string(), payload: z.record(z.string(), z.unknown()), readAt: z.string().nullable(), createdAt: z.string() });
export type NotificationItem = z.infer<typeof NotificationItem>;
export const NotificationsResponse = z.object({ rows: z.array(NotificationItem), unread: z.number().int() });
export type NotificationsResponse = z.infer<typeof NotificationsResponse>;
/** POST /me/notifications/read — these ids, or every unread one when `ids` is absent. */
export const MarkNotificationsReadInput = z.object({ ids: z.array(z.string().uuid()).max(200).optional() });
export type MarkNotificationsReadInput = z.infer<typeof MarkNotificationsReadInput>;
