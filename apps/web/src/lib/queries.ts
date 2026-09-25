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
