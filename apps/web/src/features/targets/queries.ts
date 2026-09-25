import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { api, unwrap } from "../../lib/api.js";

/** Targets as the Targets page reads them (spec §10, §18.5). */

export const TargetVersion = z
  .object({
    id: z.string().uuid(),
    versionNo: z.number(),
    value: z.string(),
    comparator: z.string(),
    valueUpper: z.string().nullable(),
    currency: z.string().nullable(),
    rationale: z.string().nullable(),
    status: z.string(),
    approvalRequestId: z.string().uuid().nullable(),
    createdAt: z.string(),
    approvedAt: z.string().nullable(),
  })
  .passthrough();
export type TargetVersion = z.infer<typeof TargetVersion>;

export const TargetRow = z
  .object({
    id: z.string().uuid(),
    scopeType: z.string(),
    envelopeId: z.string().uuid().nullable(),
    envelopeName: z.string().nullable(),
    metricKey: z.string(),
    startDate: z.string(),
    endDate: z.string(),
    status: z.string(),
    currentVersionId: z.string().uuid().nullable(),
    draftVersionId: z.string().uuid().nullable(),
    current: TargetVersion.nullable(),
    draft: TargetVersion.nullable(),
  })
  .passthrough();
export type TargetRow = z.infer<typeof TargetRow>;

export const targetsQuery = (ws: string) =>
  queryOptions({
    queryKey: ["targets", ws],
    queryFn: async () => z.array(TargetRow).parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/targets", { params: { path: { ws }, query: {} as never } }))),
  });

export const targetVersionsQuery = (ws: string, id: string) =>
  queryOptions({
    queryKey: ["target-versions", ws, id],
    queryFn: async () => z.object({ id: z.string().uuid(), versions: z.array(TargetVersion) }).passthrough().parse(await unwrap(api.GET("/api/v1/targets/{id}/versions", { params: { path: { id }, header: { "X-Workspace-Id": ws } } }))),
  });

const SYMBOL: Record<string, string> = { lte: "≤", gte: "≥", eq: "=" };

/** "≤ 12.50 USD", "10–20", for a version. */
export function formatTarget(v: Pick<TargetVersion, "value" | "comparator" | "valueUpper" | "currency">): string {
  const unit = v.currency ? ` ${v.currency}` : "";
  return v.comparator === "between" ? `${v.value}–${v.valueUpper ?? "?"}${unit}` : `${SYMBOL[v.comparator] ?? v.comparator} ${v.value}${unit}`;
}
