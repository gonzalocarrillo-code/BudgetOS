import { z } from "zod";

/** Threads, comments, subscriptions and tags (spec §13, plan §8.6). */

export const AnchorType = z.enum(["envelope", "envelope_version", "target", "approval_request", "alert", "closure", "dimension_value", "cell", "diff_field"]);
export type AnchorType = z.infer<typeof AnchorType>;

export const CommentInput = z.object({
  bodyMd: z.string().min(1).max(20_000),
  parentCommentId: z.string().uuid().optional(),
  attachments: z.array(z.object({ gcsUri: z.string().regex(/^gs:\/\/[^/]+\/.+/), name: z.string().min(1).max(200), sha256: z.string().regex(/^[0-9a-f]{64}$/) })).max(20).default([]),
});
export type CommentInput = z.infer<typeof CommentInput>;

/** POST /threads (spec §13). `anchorMeta.month` for a cell, `anchorMeta.field` for a diff field. */
export const CreateThreadInput = z.object({
  anchorType: AnchorType,
  anchorId: z.string().uuid(),
  anchorMeta: z.object({ month: z.string().date().optional(), field: z.string().max(100).optional() }).strict().default({}),
  title: z.string().max(200).optional(),
  isBlocking: z.boolean().default(false),
  firstComment: CommentInput,
});
export type CreateThreadInput = z.infer<typeof CreateThreadInput>;

/** PATCH /comments/:id: a new body; the old one goes to edit_history. */
export const UpdateCommentInput = z.object({ bodyMd: z.string().min(1).max(20_000) });
export type UpdateCommentInput = z.infer<typeof UpdateCommentInput>;

/** GET /threads?anchorType&anchorId */
export const ListThreadsQuery = z.object({ anchorType: AnchorType, anchorId: z.string().uuid() });
export type ListThreadsQuery = z.infer<typeof ListThreadsQuery>;

/** POST /subscriptions: follow (or stop following) an entity's threads. */
export const SubscriptionInput = z.object({
  entityType: z.enum(["envelope", "target", "alert", "approval_request", "thread"]),
  entityId: z.string().uuid(),
  subscribed: z.boolean().default(true),
});
export type SubscriptionInput = z.infer<typeof SubscriptionInput>;

export interface Mention {
  type: "user" | "group";
  id: string;
}
export interface Reference {
  type: "envelope" | "target" | "alert" | "request";
  id: string;
}

/**
 * The canonical forms the editor writes (spec §13): `@[user:<uuid>]`, `@[group:<uuid>]` and
 * `#[envelope|target|alert|request:<uuid>]`. Display names are resolved on read. Deduplicated,
 * in order of first appearance.
 */
export function extractMentions(bodyMd: string): { mentions: Mention[]; references: Reference[] } {
  const uniq = <T extends { type: string; id: string }>(xs: T[]) => xs.filter((x, i) => xs.findIndex((y) => y.type === x.type && y.id === x.id) === i);
  const mentions = [...bodyMd.matchAll(/@\[(user|group):([0-9a-f-]{36})\]/g)].map((m) => ({ type: m[1] as Mention["type"], id: m[2] as string }));
  const references = [...bodyMd.matchAll(/#\[(envelope|target|alert|request):([0-9a-f-]{36})\]/g)].map((m) => ({ type: m[1] as Reference["type"], id: m[2] as string }));
  return { mentions: uniq(mentions), references: uniq(references) };
}

const TagName = z.string().regex(/^[\p{L}\p{N}][\p{L}\p{N} _.:/-]{0,63}$/u, "1–64 letters, digits, space or _ . : / -");
const TagColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** POST /workspaces/:ws/tags */
export const CreateTagInput = z.object({ name: TagName, color: TagColor.optional(), kind: z.enum(["label", "status", "team", "custom"]).default("label") });
export type CreateTagInput = z.infer<typeof CreateTagInput>;

/** PATCH /tags/:id: rename, recolour, or merge into another tag (its entities move over). */
export const UpdateTagInput = z
  .object({ name: TagName.optional(), color: TagColor.nullable().optional(), kind: z.enum(["label", "status", "team", "custom"]).optional(), mergeIntoId: z.string().uuid().optional() })
  .refine((v) => Object.keys(v).length > 0, "Nothing to update")
  .refine((v) => v.mergeIntoId === undefined || Object.keys(v).length === 1, { message: "A merge takes no other changes", path: ["mergeIntoId"] });
export type UpdateTagInput = z.infer<typeof UpdateTagInput>;

export const TaggableType = z.enum(["envelope", "target", "alert", "approval_request", "thread"]);

/** POST /tags/apply and DELETE /tags/apply (spec §13: up to 10k entities in one call). */
export const ApplyTagInput = z.object({
  tagId: z.string().uuid(),
  entities: z.array(z.object({ type: TaggableType, id: z.string().uuid() })).min(1).max(10_000),
});
export type ApplyTagInput = z.infer<typeof ApplyTagInput>;
