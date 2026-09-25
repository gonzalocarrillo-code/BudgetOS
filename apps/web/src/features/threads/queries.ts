import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { api, unwrap } from "../../lib/api.js";

/** Threads, people and tags as the web reads them (spec §13), validated at the boundary. */

export type AnchorType = "envelope" | "target" | "approval_request";

export const Reaction = z.object({ emoji: z.string(), name: z.string(), count: z.number(), mine: z.boolean(), users: z.array(z.object({ id: z.string(), name: z.string() })) });
export type Reaction = z.infer<typeof Reaction>;

export const Comment = z
  .object({
    id: z.string().uuid(),
    parentCommentId: z.string().uuid().nullable(),
    authorId: z.string().uuid(),
    bodyMd: z.string().nullable(),
    createdAt: z.string(),
    editedAt: z.string().nullable(),
    deletedAt: z.string().nullable(),
    editHistory: z.array(z.object({ bodyMd: z.string(), editedAt: z.string() })),
    reactions: z.array(Reaction),
  })
  .passthrough();
export type Comment = z.infer<typeof Comment>;

export const Thread = z
  .object({
    id: z.string().uuid(),
    title: z.string().nullable(),
    status: z.string(),
    isBlocking: z.boolean(),
    createdBy: z.string().uuid(),
    createdAt: z.string(),
    resolvedBy: z.string().uuid().nullable(),
    resolvedAt: z.string().nullable(),
    comments: z.array(Comment),
    names: z.object({ users: z.record(z.string(), z.string()), groups: z.record(z.string(), z.string()) }),
  })
  .passthrough();
export type Thread = z.infer<typeof Thread>;

export const threadsKey = (ws: string, anchorType: AnchorType, anchorId: string) => ["threads", ws, anchorType, anchorId] as const;

export const threadsQuery = (ws: string, anchorType: AnchorType, anchorId: string) =>
  queryOptions({
    queryKey: threadsKey(ws, anchorType, anchorId),
    queryFn: async () => z.array(Thread).parse(await unwrap(api.GET("/api/v1/threads", { params: { header: { "X-Workspace-Id": ws }, query: { anchorType, anchorId } as never } }))),
  });

export const Person = z.object({ type: z.enum(["user", "group"]), id: z.string().uuid(), name: z.string(), email: z.string().nullable() });
export type Person = z.infer<typeof Person>;

export const peopleQuery = (ws: string, q: string) =>
  queryOptions({
    queryKey: ["people", ws, q],
    queryFn: async () => z.array(Person).parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/people", { params: { path: { ws }, query: { q, limit: 8 } as never } }))),
    staleTime: 30_000,
  });

export const Tag = z.object({ id: z.string().uuid(), name: z.string(), color: z.string().nullable(), kind: z.string().optional(), count: z.number().optional() });
export type Tag = z.infer<typeof Tag>;

export const tagsQuery = (ws: string) =>
  queryOptions({
    queryKey: ["tags", ws],
    queryFn: async () => z.array(Tag).parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/tags", { params: { path: { ws } } }))),
    staleTime: 30_000,
  });
