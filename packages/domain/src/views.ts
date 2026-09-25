import { z } from "zod";

/**
 * Saved views (spec §17 `views`, §18.3): a screen's search params under a name. Loading one
 * replaces the search params. private: the owner only; workspace: everyone in the workspace
 * (needs view.share_workspace).
 */
export const SavedViewScreen = z.enum(["explorer", "alerts", "approvals", "targets", "report"]);
export const SavedViewVisibility = z.enum(["private", "workspace"]);

export const CreateSavedViewInput = z.object({
  name: z.string().trim().min(1).max(120),
  screen: SavedViewScreen.default("explorer"),
  /** The screen's search params as the router validated them (filter, groupBy, period, view, …). */
  definition: z.record(z.string(), z.unknown()),
  visibility: SavedViewVisibility.default("private"),
});
export type CreateSavedViewInput = z.infer<typeof CreateSavedViewInput>;

export const UpdateSavedViewInput = CreateSavedViewInput.partial().omit({ screen: true });
export type UpdateSavedViewInput = z.infer<typeof UpdateSavedViewInput>;

export const ListSavedViewsQuery = z.object({ screen: SavedViewScreen.optional() });
