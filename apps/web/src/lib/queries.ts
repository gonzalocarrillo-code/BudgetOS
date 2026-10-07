import { PeriodRow } from "@budget/domain";
import { t } from "@budget/ui/i18n";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { api, unwrap } from "./api.js";

/** Server state (TanStack Query) the shell needs, validated at the boundary with zod. */

export const Me = z.object({
  user: z.object({ id: z.string().uuid(), email: z.string(), name: z.string(), orgId: z.string().uuid() }),
  isOrgAdmin: z.boolean(),
  /** ADR-052: the org-wide role, shown as Superadmin. */
  isSuperadmin: z.boolean().default(false),
  workspaces: z.array(z.object({ workspaceId: z.string().uuid(), name: z.string(), currency: z.string().default("USD"), roles: z.array(z.string()), permissions: z.array(z.string()) })),
  /** Superadmins: archived workspaces, opened read-only. */
  archivedWorkspaces: z.array(z.object({ workspaceId: z.string().uuid(), name: z.string(), archivedAt: z.string().nullable() })).default([]),
});
export type Me = z.infer<typeof Me>;

export const DimensionValue = z
  .object({
    id: z.string(),
    code: z.string(),
    label: z.string(),
    path: z.string().default(""),
    parentValueId: z.string().nullable().default(null),
    isActive: z.boolean().default(true),
    aliases: z.array(z.string()).default([]),
    mergedIntoId: z.string().nullable().default(null),
  })
  .passthrough();
export type DimensionValue = z.infer<typeof DimensionValue>;
export const Dimension = z
  .object({
    id: z.string(),
    key: z.string(),
    label: z.string(),
    icon: z.string(),
    description: z.string().nullable().default(null),
    dataType: z.string().default("ENUM"),
    color: z.string().nullable().default(null),
    allowedParents: z.array(z.string()).default([]),
    isRequiredForLeaf: z.boolean().default(false),
    workspaceId: z.string().nullable().default(null),
    isActive: z.boolean().default(true),
    values: z.array(DimensionValue),
  })
  .passthrough();
export type Dimension = z.infer<typeof Dimension>;

export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: async () => Me.parse(await unwrap(api.GET("/api/v1/me"))),
  staleTime: 60_000,
});

/**
 * T-5 (audit): demo rows left, and whether the workspace has real (non-demo) budgets too. HF-1: `hidden`
 * is true exactly when the planner is excluding demo money from totals right now (envelopes > 0 &&
 * hasRealBudgets) — the condition every "demo data is hidden" banner and the Slack context line key off.
 */
export const DemoStatus = z.object({ envelopes: z.number(), targets: z.number(), hasRealBudgets: z.boolean().default(false), hidden: z.boolean().default(false), hasCampaignData: z.boolean().default(false) });
export type DemoStatus = z.infer<typeof DemoStatus>;

export const demoStatusQuery = (ws: string) =>
  queryOptions({
    queryKey: ["demo-data", ws],
    queryFn: async () => DemoStatus.parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/demo-data", { params: { path: { ws } } }))),
  });

export const registryQuery = (ws: string) =>
  queryOptions({
    queryKey: ["registry", ws],
    queryFn: async () => z.array(Dimension).parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/dimensions", { params: { path: { ws } } }))),
    staleTime: 10_000,
  });

export const Template = z.object({ id: z.string().uuid(), name: z.string(), path: z.array(z.string()), isDefault: z.boolean() });
export type Template = z.infer<typeof Template>;

export const templatesQuery = (ws: string) =>
  queryOptions({
    queryKey: ["templates", ws],
    queryFn: async () => z.array(Template).parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/hierarchy-templates", { params: { path: { ws } } }))),
    staleTime: 60_000,
  });

export const SavedView = z.object({ id: z.string().uuid(), name: z.string(), screen: z.string(), definition: z.record(z.string(), z.unknown()), visibility: z.string(), createdBy: z.string().uuid() });
export type SavedView = z.infer<typeof SavedView>;

export const savedViewsQuery = (ws: string) =>
  queryOptions({
    queryKey: ["saved-views", ws],
    queryFn: async () => z.array(SavedView).parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/saved-views", { params: { path: { ws }, query: { screen: "explorer" } } }))),
  });

const Version = z.object({ id: z.string().uuid(), versionNo: z.number(), amount: z.string(), status: z.string() }).passthrough();
/** A neighbour in the tree (T-031b): parent, child or sibling, with its approved amount. */
export const StructureNode = z.object({ id: z.string().uuid(), name: z.string(), status: z.string(), currency: z.string(), approved: z.string().nullable(), dimensionValues: z.record(z.string(), z.string()).default({}), ended: z.boolean().default(false) });
export type StructureNode = z.infer<typeof StructureNode>;
const LineageLink = z.object({ id: z.string().uuid(), name: z.string(), status: z.string(), startDate: z.string(), endDate: z.string(), ended: z.boolean() });

export const EnvelopeDetail = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    status: z.string(),
    currency: z.string(),
    startDate: z.string(),
    endDate: z.string(),
    dimensionValues: z.record(z.string(), z.string()),
    current: Version.nullable(),
    draft: Version.nullable(),
    tags: z.array(z.object({ id: z.string().uuid(), name: z.string(), color: z.string().nullable() })).default([]),
    parentId: z.string().uuid().nullable().default(null),
    rowVersion: z.number().default(1),
    currentVersionId: z.string().uuid().nullable().default(null),
    draftVersionId: z.string().uuid().nullable().default(null),
    /** The draft's pending approval request, when it has been sent. */
    openRequest: z.object({ id: z.string().uuid(), status: z.string(), summary: z.string() }).nullable().default(null),
    /** The policy the open draft would match if sent now: no steps = set at once. */
    draftPolicy: z.object({ name: z.string(), autoApprove: z.boolean(), firstRole: z.string().nullable(), steps: z.number() }).nullable().default(null),
    structure: z
      .object({ parent: StructureNode.nullable(), children: z.array(StructureNode), siblings: z.array(StructureNode) })
      .default({ parent: null, children: [], siblings: [] }),
    /** H-011: when it ended; an ended budget is read-only. */
    ended: z.object({ at: z.string(), by: z.string().nullable(), reason: z.string().nullable() }).nullable().default(null),
    /** What the open bulk request holding its draft does (split, merge, end…). */
    pendingKind: z.string().nullable().default(null),
    /** H-012: the budget it continues, and the ones that continue it. */
    lineage: z
      .object({ continues: LineageLink.nullable(), continuedBy: z.array(LineageLink) })
      .default({ continues: null, continuedBy: [] }),
  })
  .passthrough();
export type EnvelopeDetail = z.infer<typeof EnvelopeDetail>;

export const envelopeQuery = (ws: string, id: string) =>
  queryOptions({
    queryKey: ["envelope", ws, id],
    queryFn: async () => EnvelopeDetail.parse(await unwrap(api.GET("/api/v1/envelopes/{id}", { params: { path: { id }, header: { "X-Workspace-Id": ws } } }))),
  });

export const SearchHit = z.object({ id: z.string(), title: z.string(), path: z.string().nullable(), status: z.string().nullable(), facets: z.record(z.string(), z.unknown()).nullable().optional(), deepLink: z.string() });
export const SearchResult = z.object({ groups: z.array(z.object({ type: z.string(), count: z.number(), more: z.boolean().optional(), hits: z.array(SearchHit) })) }).passthrough();
/** A group's count; "1000+" when the server stopped counting (T-034). */
export const searchCount = (g: { count: number; more?: boolean | undefined }): string => (g.more ? t("search.countMore", { count: g.count }) : String(g.count));
export type SearchResult = z.infer<typeof SearchResult>;
export const SuggestResult = z.object({ keys: z.array(z.object({ key: z.string(), label: z.string(), kind: z.string() })), values: z.array(z.object({ value: z.string(), label: z.string() })) });

export const searchQuery = (ws: string, q: string, opts: { types?: string | undefined; limit?: number } = {}) =>
  queryOptions({
    queryKey: ["search", ws, q, opts.types ?? "", opts.limit ?? 5],
    queryFn: async () => SearchResult.parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/search", { params: { path: { ws }, query: { q, limit: opts.limit ?? 5, ...(opts.types ? { types: opts.types } : {}) } as never } }))),
    staleTime: 5_000,
  });

export const suggestQuery = (ws: string, prefix: string) =>
  queryOptions({
    queryKey: ["suggest", ws, prefix],
    queryFn: async () => SuggestResult.parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/search/suggest", { params: { path: { ws }, query: { prefix } as never } }))),
    staleTime: 10_000,
  });

export const ApprovalRow = z
  .object({
    id: z.string().uuid(),
    entityType: z.string(),
    status: z.string(),
    summary: z.string().nullable(),
    envelopeId: z.string().uuid().nullable(),
    amount: z.string().nullable(),
    rows: z.number(),
    currentStep: z.number(),
    requestedBy: z.string().uuid(),
    requestedByName: z.string().nullable().optional(),
    requestedAt: z.string(),
    dueAt: z.string().nullable(),
  })
  .passthrough();
export type ApprovalRow = z.infer<typeof ApprovalRow>;

export const approvalsQuery = (ws: string, tab: "mine" | "open" | "resolved") =>
  queryOptions({
    queryKey: ["approvals", ws, tab],
    queryFn: async () =>
      z.object({ rows: z.array(ApprovalRow), nextCursor: z.string().nullable() }).parse(
        await unwrap(
          api.GET("/api/v1/approvals", {
            params: { header: { "X-Workspace-Id": ws }, query: { ...(tab === "mine" ? { assignee: "me" } : {}), status: tab === "resolved" ? "APPROVED,REJECTED,CHANGES_REQUESTED,WITHDRAWN" : "PENDING,ESCALATED", limit: 100 } as never },
          }),
        ),
      ),
  });

const ChainStep = z.object({ role: z.string(), minApprovals: z.number().optional(), timeoutHours: z.number().optional(), escalatedFrom: z.number().optional() }).passthrough();
export const ApprovalDetail = z
  .object({
    id: z.string().uuid(),
    entityType: z.string(),
    status: z.string(),
    summary: z.string().nullable(),
    currentStep: z.number(),
    policySnapshot: z.object({ chain: z.array(ChainStep), policyName: z.string().optional(), blockSelfApproval: z.boolean().optional() }).passthrough(),
    requestedBy: z.string().uuid(),
    requestedAt: z.string(),
    dueAt: z.string().nullable(),
    resolvedAt: z.string().nullable(),
    envelope: z.object({ id: z.string().uuid(), name: z.string(), currency: z.string(), dimensionValues: z.record(z.string(), z.string()) }).nullable(),
    rows: z.array(z.object({ envelopeId: z.string().uuid(), envelopeName: z.string(), versionId: z.string().uuid(), amount: z.string(), amountReporting: z.string(), approvedAmountReporting: z.string().nullable(), rationale: z.string().nullable() }).passthrough()),
    people: z.record(z.string(), z.string()),
    decision: z.object({ canDecide: z.boolean(), reason: z.string().nullable(), stepRole: z.string().nullable() }),
    decisions: z.array(z.object({ id: z.string().uuid(), stepIndex: z.number(), decidedBy: z.string().uuid(), decision: z.string(), comment: z.string().nullable(), decidedAt: z.string() }).passthrough()),
    /** T-039: a manual result batch waiting for approval — what it would load. */
    manualEntry: z
      .object({
        id: z.string().uuid(),
        channel: z.string(),
        periodStart: z.string(),
        periodEnd: z.string(),
        totals: z.object({ amount: z.string().nullable(), byCurrency: z.record(z.string(), z.string()), rows: z.number() }).passthrough(),
        rows: z.array(z.object({ rowNo: z.number(), dimensionValues: z.record(z.string(), z.string()), periodDate: z.string(), currency: z.string(), amount: z.string(), kpis: z.record(z.string(), z.string()), note: z.string().optional() }).passthrough()),
      })
      .nullable()
      .optional(),
  })
  .passthrough();
export type ApprovalDetail = z.infer<typeof ApprovalDetail>;

export const approvalQuery = (ws: string, id: string) =>
  queryOptions({
    queryKey: ["approval", ws, id],
    queryFn: async () => ApprovalDetail.parse(await unwrap(api.GET("/api/v1/approvals/{id}", { params: { path: { id }, header: { "X-Workspace-Id": ws } } }))),
  });

export const TimelineEntry = z.object({
  at: z.string(),
  id: z.string(),
  source: z.string(),
  kind: z.string(),
  title: z.string(),
  actor: z.object({ id: z.string().nullable(), name: z.string().nullable(), type: z.string().nullable() }).nullable(),
  detail: z.object({ before: z.unknown(), after: z.unknown(), reason: z.string().nullable(), body: z.string().nullable() }).passthrough(),
});
export type TimelineEntry = z.infer<typeof TimelineEntry>;

export const timelinePage = async (ws: string, id: string, cursor: string | null) =>
  z.object({ rows: z.array(TimelineEntry), nextCursor: z.string().nullable() }).parse(
    await unwrap(api.GET("/api/v1/envelopes/{id}/timeline", { params: { path: { id }, header: { "X-Workspace-Id": ws }, query: { limit: 50, ...(cursor ? { cursor } : {}) } as never } })),
  );

/** The workspace's fiscal calendar (ADR-041): years, quarters, months as defined, custom partitions. */
export const periodsQuery = (ws: string) =>
  queryOptions({
    queryKey: ["periods", ws],
    queryFn: async () => z.array(PeriodRow).parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/periods", { params: { path: { ws } } }))),
    staleTime: 60_000,
  });
