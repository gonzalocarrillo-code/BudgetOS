import { z } from "zod";

/**
 * Saved views (spec §17 `views`, §18.3): a screen's search params under a name. Loading one
 * replaces the search params. private: the owner only; workspace: everyone in the workspace
 * (needs view.share_workspace).
 */
export const SavedViewScreen = z.enum(["explorer", "alerts", "approvals", "targets", "report", "overview"]);
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

// ---- The Overview's layout (ADR-045, HO-015) ---------------------------------------------------

/** What can be hidden: each headline tile and each block. */
export const OVERVIEW_SECTIONS = ["headline.budget", "headline.spent", "headline.remaining", "headline.projected", "heatmap", "attention", "alerts", "kpi", "queue", "data"] as const;
/** What can be moved: the blocks, top to bottom (the tiles move with the headline). */
export const OVERVIEW_BLOCKS = ["headline", "heatmap", "attention", "alerts", "kpi", "queue", "data"] as const;
export type OverviewBlock = (typeof OVERVIEW_BLOCKS)[number];

/**
 * A person's Overview (a saved view with screen "overview", `definition`): what is hidden, the
 * blocks' order, and the heatmap's rows, columns and sort, so they come back without the URL.
 */
export const OverviewLayout = z.object({
  hidden: z.array(z.string()).default([]),
  order: z.array(z.enum(OVERVIEW_BLOCKS)).default([]),
  axes: z.object({ rows: z.string().min(1).max(80).optional(), cols: z.string().min(1).max(80).optional() }).default({}),
  sort: z.enum(["budget", "pace", "ahead"]).optional(),
});
export type OverviewLayout = z.infer<typeof OverviewLayout>;

/** Keys from the first Overview (ADR-045) and what they are now; tiles that moved to Home have none. */
const LEGACY: Record<string, string | null> = {
  "tile.budget": "headline.budget",
  "tile.actual": "headline.spent",
  "tile.spent": "headline.spent",
  "tile.projected": "headline.projected",
  "tile.alerts": null,
  "tile.approvals": null,
  "tile.sincePlan": null,
  approvals: "queue",
  freshness: "data",
};

/**
 * A saved definition as a layout: old keys mapped (both pace lists hidden hides Needs attention), and
 * every block in the order, the saved ones first, the rest in the default order. Never throws.
 */
export function readOverviewLayout(definition: unknown): OverviewLayout {
  const raw = (definition ?? {}) as { hidden?: unknown; order?: unknown; axes?: unknown; sort?: unknown };
  const hidden = new Set<string>();
  const was = Array.isArray(raw.hidden) ? raw.hidden.filter((x): x is string => typeof x === "string") : [];
  for (const key of was) {
    const now = key in LEGACY ? LEGACY[key] : key;
    if (now && (OVERVIEW_SECTIONS as readonly string[]).includes(now)) hidden.add(now);
  }
  if (was.includes("overPace") && was.includes("underPace")) hidden.add("attention");
  const saved = Array.isArray(raw.order) ? raw.order.filter((x): x is OverviewBlock => (OVERVIEW_BLOCKS as readonly string[]).includes(x as string)) : [];
  const order = [...new Set([...saved, ...OVERVIEW_BLOCKS])];
  const parsed = OverviewLayout.safeParse({ hidden: [...hidden], order, axes: raw.axes ?? {}, ...(raw.sort === undefined ? {} : { sort: raw.sort }) });
  return parsed.success ? parsed.data : { hidden: [...hidden], order, axes: {} };
}
