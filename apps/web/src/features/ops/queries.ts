import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { api, unwrap } from "../../lib/api.js";

/** Alerts, pacing rules, closures and sources as the T-032 screens read them, validated at the boundary. */

const H = (ws: string) => ({ "X-Workspace-Id": ws });

export const Alert = z
  .object({
    id: z.string().uuid(),
    ruleId: z.string().uuid(),
    envelopeId: z.string().uuid(),
    envelopeName: z.string().nullable().default(null),
    ruleName: z.string().nullable().default(null),
    metric: z.string().nullable().default(null),
    comparator: z.string().nullable().default(null),
    severity: z.string(),
    status: z.string(),
    metricValue: z.string(),
    threshold: z.string(),
    context: z.record(z.string(), z.unknown()).nullable().default(null),
    ownerId: z.string().uuid().nullable(),
    openedAt: z.string(),
    snoozedUntil: z.string().nullable(),
    resolvedAt: z.string().nullable(),
  })
  .passthrough();
export type Alert = z.infer<typeof Alert>;

export const alertsQuery = (ws: string, status: string, severity: string | undefined) =>
  queryOptions({
    queryKey: ["alerts", ws, status, severity ?? ""],
    queryFn: async () => z.array(Alert).parse(await unwrap(api.GET("/api/v1/alerts", { params: { header: H(ws), query: { status, limit: 200, ...(severity ? { severity } : {}) } as never } }))),
  });

export const Rule = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    scope: z.unknown().nullable(),
    metric: z.string(),
    metricArgs: z.record(z.string(), z.unknown()).default({}),
    comparator: z.string(),
    threshold: z.string(),
    consecutiveDays: z.number(),
    severity: z.string(),
    delivery: z.object({ inApp: z.boolean().optional(), slackChannel: z.string().optional(), emails: z.array(z.string()).optional() }).passthrough().default({}),
    isActive: z.boolean(),
  })
  .passthrough();
export type Rule = z.infer<typeof Rule>;

export const rulesQuery = (ws: string) =>
  queryOptions({
    queryKey: ["rules", ws],
    queryFn: async () => z.array(Rule).parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/rules", { params: { path: { ws } } }))),
  });

export const Closure = z.object({
  id: z.string().uuid(),
  period: z.object({ id: z.string().uuid(), key: z.string(), kind: z.string(), start: z.string(), end: z.string() }),
  status: z.string(),
  closedBy: z.string().uuid(),
  closedAt: z.string(),
  table: z.string(),
  lockedEnvelopes: z.number(),
});
export type Closure = z.infer<typeof Closure>;

export const closuresQuery = (ws: string) =>
  queryOptions({
    queryKey: ["closures", ws],
    queryFn: async () => z.array(Closure).parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/closures", { params: { path: { ws } } }))),
  });

const Money = z.string().nullable();
export const ClosureReport = z.object({
  closure: Closure,
  summary: z
    .object({
      currency: z.string().optional(),
      lockedEnvelopes: z.number().optional(),
      rows: z.number().optional(),
      totals: z.object({ budget: Money, actual: Money, projected: Money, remaining: Money, variance: z.string(), variancePct: z.string().nullable() }).nullable().optional(),
      months: z.array(z.object({ month: z.string(), actual: z.string(), projected: z.string() })).optional(),
      byTemplate: z.array(z.object({ templateId: z.string(), name: z.string(), nodes: z.number(), top: z.array(z.object({ nodePath: z.string(), budget: z.string(), actual: z.string(), variance: z.string(), variancePct: z.string().nullable() })) })).optional(),
    })
    .passthrough(),
});
export type ClosureReport = z.infer<typeof ClosureReport>;

export const closureReportQuery = (ws: string, id: string) =>
  queryOptions({
    queryKey: ["closure-report", ws, id],
    queryFn: async () => ClosureReport.parse(await unwrap(api.GET("/api/v1/closures/{id}/report", { params: { path: { id }, header: H(ws) } }))),
  });

export const Source = z.object({ id: z.string().uuid(), kind: z.string(), name: z.string(), config: z.record(z.string(), z.unknown()), mapping: z.object({ kind: z.string(), columns: z.record(z.string(), z.record(z.string(), z.unknown())) }).passthrough(), schedule: z.string().nullable(), isActive: z.boolean() });
export type Source = z.infer<typeof Source>;

export const sourcesQuery = (ws: string) =>
  queryOptions({
    queryKey: ["sources", ws],
    queryFn: async () => z.array(Source).parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/sources", { params: { path: { ws } } }))),
  });

export const Run = z.object({
  id: z.string().uuid(),
  status: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  rowsRead: z.number().nullable(),
  rowsAccepted: z.number().nullable(),
  rowsRejected: z.number().nullable(),
  errorReportUri: z.string().nullable(),
  summary: z.record(z.string(), z.unknown()).nullable(),
});
export type Run = z.infer<typeof Run>;

export const runsQuery = (ws: string, sourceId: string) =>
  queryOptions({
    queryKey: ["runs", ws, sourceId],
    queryFn: async () => z.array(Run).parse(await unwrap(api.GET("/api/v1/sources/{id}/runs", { params: { path: { id: sourceId }, header: H(ws) } }))),
    // A queued or running run changes on its own: look again every 2 s until it settles.
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === "queued" || r.status === "running") ? 2000 : false),
  });

export const Unmatched = z.object({ dimensionValues: z.record(z.string(), z.string()), rows: z.number(), amountReporting: z.string(), firstDate: z.string(), lastDate: z.string() });
export type Unmatched = z.infer<typeof Unmatched>;

export const unmatchedQuery = (ws: string) =>
  queryOptions({
    queryKey: ["unmatched", ws],
    queryFn: async () => z.array(Unmatched).parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/unmatched-spend", { params: { path: { ws }, query: { limit: 100 } as never } }))),
  });

/** The caller's permissions in this workspace (from /me), to disable what the role cannot do, with a reason. */
export const can = (perms: string[], isOrgAdmin: boolean, action: string) => isOrgAdmin || perms.includes(action);
