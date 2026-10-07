import { ExperimentReadout, ExperimentSides, FilterGroup, SuccessCriterion } from "@budget/domain";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { api, unwrap } from "../../lib/api.js";

/** Experiments as the Experiments screens read them (spec §25). */

export const STATUSES = ["PLANNED", "RUNNING", "EVALUATING", "CONCLUDED", "ABANDONED"] as const;
export const KINDS = ["PLATFORM_TEST", "OBJECTIVE_TEST", "AUDIENCE_TEST", "CREATIVE_TEST", "GEO_HOLDOUT", "CUSTOM"] as const;

export const Experiment = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    hypothesis: z.string(),
    kind: z.enum(KINDS),
    testFilter: FilterGroup,
    controlFilter: FilterGroup.nullable(),
    primaryMetric: z.string(),
    criterion: SuccessCriterion,
    startDate: z.string(),
    endDate: z.string(),
    testScopeKind: z.enum(["envelope", "fact"]).default("envelope"),
    controlScopeKind: z.enum(["envelope", "fact"]).default("envelope"),
    status: z.enum(STATUSES),
    ownerId: z.string().uuid(),
    decision: z.string().nullable(),
    decidedBy: z.string().uuid().nullable(),
    decidedAt: z.string().nullable(),
    createdAt: z.string(),
    envelopes: z.array(z.object({ envelopeId: z.string().uuid(), role: z.enum(["TEST", "CONTROL"]), name: z.string().nullable().optional() })).default([]),
  })
  .passthrough();
export type Experiment = z.infer<typeof Experiment>;

export const experimentsQuery = (ws: string, status: string | undefined) =>
  queryOptions({
    queryKey: ["experiments", ws, status ?? null],
    queryFn: async () => z.array(Experiment).parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/experiments", { params: { path: { ws }, query: (status ? { status } : {}) as never } }))),
  });

export const experimentQuery = (ws: string, id: string) =>
  queryOptions({
    queryKey: ["experiment", ws, id],
    queryFn: async () => z.object({ experiment: Experiment, readout: ExperimentReadout, sides: ExperimentSides }).parse(await unwrap(api.GET("/api/v1/experiments/{id}", { params: { path: { id }, header: { "X-Workspace-Id": ws } } }))),
  });

export const Metric = z.object({ key: z.string(), label: z.string(), direction: z.string().optional() }).passthrough();
export const metricsQuery = (ws: string) =>
  queryOptions({
    queryKey: ["metrics", ws],
    queryFn: async () => z.array(Metric).parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/metrics", { params: { path: { ws } } }))),
    staleTime: 5 * 60_000,
  });
