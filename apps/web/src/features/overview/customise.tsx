import { OVERVIEW_SECTIONS, readOverviewLayout, type OverviewBlock, type OverviewLayout } from "@budget/domain";
import { Button, Popover, PopoverContent, PopoverTrigger, toast } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, SlidersHorizontal } from "lucide-react";
import { useRef, useState, type ReactElement } from "react";
import { z } from "zod";
import { api, unwrap } from "../../lib/api.js";
import { meQuery, SavedView } from "../../lib/queries.js";

/**
 * What each person sees on the Overview (ADR-045, HO-015): hidden tiles and blocks, the blocks'
 * order, and the heatmap's rows, columns and sort, kept as their private `overview` saved view. The
 * workspace default (a shared view, set here by admins) is what everyone without one sees; "Use the
 * default" drops the private view and goes back to it.
 */
const LAYOUT_NAME = "Overview layout";
const DEFAULT_NAME = "Overview default";
export type Section = (typeof OVERVIEW_SECTIONS)[number];

export function useLayout(ws: string) {
  const client = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const viewsKey = ["saved-views", ws, "overview"];
  const viewsQuery = {
    queryKey: viewsKey,
    queryFn: async () => z.array(SavedView).parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/saved-views", { params: { path: { ws }, query: { screen: "overview" } as never } }))),
  };
  const { data: views = [], isPending } = useQuery(viewsQuery);
  const mineOf = (vs: SavedView[]) => vs.find((v) => v.createdBy === me?.user.id && v.visibility === "private") ?? null;
  const mine = mineOf(views);
  // The workspace default is a workspace or shared view of that name; another workspace/shared Overview view stands in.
  const byDefault = views.find((v) => (v.visibility === "workspace" || v.visibility === "shared") && v.name === DEFAULT_NAME) ?? null;
  const shared = byDefault ?? views.find((v) => v.visibility === "workspace" || v.visibility === "shared") ?? null;
  const fallback = readOverviewLayout(shared?.definition);
  // The choice shows at once; saves run one after another, and the last one's result stays shown.
  const [pending, setPending] = useState<OverviewLayout | null>(null);
  const latest = useRef<OverviewLayout | null>(null);
  const layout = pending ?? (mine ? readOverviewLayout(mine.definition) : fallback);
  const settle = async (next: OverviewLayout) => {
    await client.invalidateQueries({ queryKey: viewsKey });
    if (latest.current === next) setPending(null);
  };
  const scope = { id: `overview-layout-${ws}` };
  const save = useMutation({
    scope,
    mutationFn: async (next: OverviewLayout) => {
      // Looked up fresh: the save before this one may have just created the view.
      const current = mineOf(await client.fetchQuery({ ...viewsQuery, staleTime: 0 }));
      return current
        ? unwrap(api.PATCH("/api/v1/saved-views/{id}", { params: { path: { id: current.id }, header: { "X-Workspace-Id": ws } }, body: { definition: next } as never }))
        : unwrap(api.POST("/api/v1/workspaces/{ws}/saved-views", { params: { path: { ws } }, body: { name: LAYOUT_NAME, screen: "overview", definition: next, visibility: "private" } as never }));
    },
    onSettled: (_r, _e, next) => settle(next),
  });
  // Its variable is the layout shown meanwhile (the default), for `settle`.
  const drop = useMutation<void, Error, OverviewLayout>({
    scope,
    mutationFn: async () => {
      const current = mineOf(await client.fetchQuery({ ...viewsQuery, staleTime: 0 }));
      if (current) await unwrap(api.DELETE("/api/v1/saved-views/{id}", { params: { path: { id: current.id }, header: { "X-Workspace-Id": ws } } }));
    },
    onSettled: (_r, _e, next) => settle(next),
  });
  const share = useMutation({
    meta: { error: true },
    mutationFn: async (definition: OverviewLayout) =>
      byDefault
        ? unwrap(api.PATCH("/api/v1/saved-views/{id}", { params: { path: { id: byDefault.id }, header: { "X-Workspace-Id": ws } }, body: { definition } as never }))
        : unwrap(api.POST("/api/v1/workspaces/{ws}/saved-views", { params: { path: { ws } }, body: { name: DEFAULT_NAME, screen: "overview", definition, visibility: "workspace" } as never })),
    onSuccess: async () => {
      toast.success(t("overview.customise.shared"));
      await client.invalidateQueries({ queryKey: viewsKey });
    },
  });
  const apply = (next: OverviewLayout) => {
    latest.current = next;
    setPending(next);
    save.mutate(next);
  };
  const shows = (s: Section) => !layout.hidden.includes(s);
  const toggle = (s: Section) => apply({ ...layout, hidden: shows(s) ? [...layout.hidden, s] : layout.hidden.filter((x) => x !== s) });
  const move = (b: OverviewBlock, by: -1 | 1) => {
    const order = [...layout.order];
    const i = order.indexOf(b);
    const j = i + by;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j] as OverviewBlock, order[i] as OverviewBlock];
    apply({ ...layout, order });
  };
  const reset = () => {
    // Back to the workspace default: the private layout goes (the built-in one when nobody set a default).
    latest.current = fallback;
    setPending(fallback);
    drop.mutate(fallback);
  };
  /** The heatmap's rows, columns or sort, kept for next time (the URL still wins while it has them). */
  const remember = (axes: Partial<OverviewLayout["axes"]>, sort?: OverviewLayout["sort"]) => apply({ ...layout, axes: { ...layout.axes, ...axes }, ...(sort ? { sort } : {}) });
  const perms = me?.workspaces.find((w) => w.workspaceId === ws)?.permissions ?? [];
  return {
    layout,
    shows,
    toggle,
    move,
    reset,
    remember,
    share: () => share.mutate(layout),
    canShare: me?.isOrgAdmin === true || perms.includes("view.share_workspace"),
    sharing: share.isPending,
    /** Whether this person has their own layout (else they see the workspace default). */
    own: pending !== null ? latest.current !== fallback : mine !== null,
    hiddenCount: layout.hidden.length,
    saving: save.isPending || drop.isPending,
    ready: me !== undefined && !isPending,
  };
}
export type Layout = ReturnType<typeof useLayout>;

const TILES: Section[] = ["headline.budget", "headline.spent", "headline.remaining", "headline.projected"];
const sectionLabel = (s: Section) => t(`overview.section.${s}` as MessageKey);
const blockLabel = (b: OverviewBlock) => t(`overview.block.${b}` as MessageKey);

export function Customise({ layout }: { layout: Layout }): ReactElement {
  const order = layout.layout.order;
  const check = (s: Section, label: string) => (
    <label className="flex flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-sm hover:bg-accent">
      <input type="checkbox" checked={layout.shows(s)} onChange={() => layout.toggle(s)} data-testid={`customise-${s}`} />
      {label}
    </label>
  );
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" data-testid="overview-customise" data-saving={layout.saving}>
          <SlidersHorizontal className="size-4" aria-hidden />
          {layout.hiddenCount ? t("overview.customise.withHidden", { count: layout.hiddenCount }) : t("overview.customise")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80" aria-label={t("overview.customise")} data-testid="overview-customise-menu">
        <p className="pb-2 text-xs text-muted-foreground">{t("overview.customise.help")}</p>
        <ol className="flex flex-col gap-1" aria-label={t("overview.customise.order")}>
          {order.map((b, i) => (
            <li key={b} className="rounded-lg border border-border p-1.5" data-testid={`customise-block-${b}`}>
              <div className="flex items-center gap-2">
                {b === "headline" ? <span className="flex-1 px-1 py-0.5 text-sm font-medium">{blockLabel(b)}</span> : check(b as Section, blockLabel(b))}
                {/* The first block has no "up" and the last no "down": a gap keeps the arrows aligned. */}
                <span className="flex">
                  {i > 0 ? <MoveButton dir="up" name={blockLabel(b)} onClick={() => layout.move(b, -1)} testId={`customise-up-${b}`} /> : <span className="size-7" aria-hidden />}
                  {i < order.length - 1 ? <MoveButton dir="down" name={blockLabel(b)} onClick={() => layout.move(b, 1)} testId={`customise-down-${b}`} /> : <span className="size-7" aria-hidden />}
                </span>
              </div>
              {b === "headline" ? (
                <div className="flex flex-col gap-0.5 pl-3">
                  {TILES.map((s) => (
                    <div key={s} className="flex">
                      {check(s, sectionLabel(s))}
                    </div>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
        <p className="pt-2 text-xs text-muted-foreground">{t("overview.customise.kept")}</p>
        <div className="flex flex-wrap justify-between gap-2 pt-2">
          {layout.own ? (
            <Button size="sm" variant="ghost" onClick={layout.reset} data-testid="customise-reset">
              {t("overview.customise.reset")}
            </Button>
          ) : (
            <Button size="sm" variant="ghost" disabled reason={t("overview.customise.nothingHidden")}>
              {t("overview.customise.reset")}
            </Button>
          )}
          {layout.canShare ? (
            layout.sharing ? (
              <Button size="sm" variant="outline" disabled reason={t("shell.loading")}>
                {t("overview.customise.shareDefault")}
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={layout.share} data-testid="customise-share">
                {t("overview.customise.shareDefault")}
              </Button>
            )
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function MoveButton({ dir, name, onClick, testId }: { dir: "up" | "down"; name: string; onClick: () => void; testId: string }): ReactElement {
  const Icon = dir === "up" ? ArrowUp : ArrowDown;
  const label = t(dir === "up" ? "overview.customise.up" : "overview.customise.down", { name });
  return (
    <button type="button" className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" onClick={onClick} aria-label={label} title={label} data-testid={testId}>
      <Icon className="size-3.5" aria-hidden />
    </button>
  );
}
