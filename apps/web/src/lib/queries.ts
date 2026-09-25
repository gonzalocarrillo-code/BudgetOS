import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { api, unwrap } from "./api.js";

/** Server state (TanStack Query) the shell needs, validated at the boundary with zod. */

export const Me = z.object({
  user: z.object({ id: z.string().uuid(), email: z.string(), name: z.string(), orgId: z.string().uuid() }),
  isOrgAdmin: z.boolean(),
  workspaces: z.array(z.object({ workspaceId: z.string().uuid(), name: z.string(), roles: z.array(z.string()), permissions: z.array(z.string()) })),
});
export type Me = z.infer<typeof Me>;

export const Dimension = z.object({ id: z.string(), key: z.string(), label: z.string(), icon: z.string(), values: z.array(z.object({ id: z.string(), code: z.string(), label: z.string() }).passthrough()) }).passthrough();
export type Dimension = z.infer<typeof Dimension>;

export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: async () => Me.parse(await unwrap(api.GET("/api/v1/me"))),
  staleTime: 60_000,
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
  })
  .passthrough();
export type EnvelopeDetail = z.infer<typeof EnvelopeDetail>;

export const envelopeQuery = (ws: string, id: string) =>
  queryOptions({
    queryKey: ["envelope", ws, id],
    queryFn: async () => EnvelopeDetail.parse(await unwrap(api.GET("/api/v1/envelopes/{id}", { params: { path: { id }, header: { "X-Workspace-Id": ws } } }))),
  });

export const SearchHit = z.object({ id: z.string(), title: z.string(), path: z.string().nullable(), status: z.string().nullable(), facets: z.record(z.string(), z.unknown()).nullable().optional(), deepLink: z.string() });
export const SearchResult = z.object({ groups: z.array(z.object({ type: z.string(), count: z.number(), hits: z.array(SearchHit) })) }).passthrough();
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
