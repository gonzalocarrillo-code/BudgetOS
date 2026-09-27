import { ManualEntryIssue, ManualEntryRowInput, ManualEntryTotals } from "@budget/domain";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { api, unwrap } from "../../lib/api.js";

/** Manual result entry as the screen reads it (spec §26). */

const Status = z.enum(["DRAFT", "SUBMITTED", "APPROVED", "REJECTED"]);
export const BatchSummary = z
  .object({ id: z.string().uuid(), channel: z.string(), periodStart: z.string(), periodEnd: z.string(), status: Status, totals: ManualEntryTotals, rowCount: z.number(), approvalRequestId: z.string().uuid().nullable(), createdAt: z.string() })
  .passthrough();
export type BatchSummary = z.infer<typeof BatchSummary>;

export const Batch = z
  .object({
    id: z.string().uuid(),
    channel: z.string(),
    periodStart: z.string(),
    periodEnd: z.string(),
    status: Status,
    rows: z.array(ManualEntryRowInput),
    totals: ManualEntryTotals,
    approvalRequestId: z.string().uuid().nullable(),
    issues: z.array(ManualEntryIssue),
    warnings: z.array(ManualEntryIssue),
    lastRequest: z.object({ id: z.string().uuid(), status: z.string(), decision: z.object({ decision: z.string(), comment: z.string().nullable() }).nullable() }).passthrough().nullable().optional(),
    lineage: z.array(z.object({ rowNo: z.number(), factTable: z.string(), metric: z.string().nullable() }).passthrough()).optional(),
  })
  .passthrough();
export type Batch = z.infer<typeof Batch>;

export const batchesQuery = (ws: string, channel: string) =>
  queryOptions({
    queryKey: ["manual-entries", ws, channel],
    queryFn: async () => z.array(BatchSummary).parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/manual-entries", { params: { path: { ws }, query: { channel } as never } }))),
  });

export const batchQuery = (ws: string, id: string) =>
  queryOptions({
    queryKey: ["manual-entry", ws, id],
    queryFn: async () => Batch.parse(await unwrap(api.GET("/api/v1/manual-entries/{id}", { params: { path: { id }, header: { "X-Workspace-Id": ws } } }))),
  });

/** A stable colour per channel (the registry has no colour field): the design palette by position. */
const PALETTE = ["#1877f2", "#12a37a", "#e8a317", "#e5484d", "#7c5cff", "#0ea5b7", "#d9468f", "#6b7a90", "#2f9e44", "#b7791f", "#5b6cff", "#c2410c", "#0891b2"];
export const channelColor = (index: number) => PALETTE[index % PALETTE.length] as string;
