import { formatMoney } from "@budget/grid";
import { Button } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useState, type KeyboardEvent, type ReactElement } from "react";
import { HistoryList } from "../history/history-list.js";
import { threadsQuery } from "../threads/queries.js";
import { TagChips } from "../threads/tag-chips.js";
import { ThreadPanel } from "../threads/thread-panel.js";
import { envelopeQuery, registryQuery } from "../../lib/queries.js";
import { DimensionIcon } from "../registry/dimension-icon.js";

type Tab = "details" | "history" | "comments";

/**
 * The envelope drawer (`select` search param): Details (approved budget, open draft, dimensions,
 * tags), History (every change, T-029) and Comments (threads, T-030). Every budget always has all three.
 */
export function EnvelopeDrawer({ ws, id, onClose }: { ws: string; id: string; onClose: () => void }): ReactElement {
  const client = useQueryClient();
  const { data, error } = useQuery(envelopeQuery(ws, id));
  const { data: threads } = useQuery(threadsQuery(ws, "envelope", id));
  const { data: dims = [] } = useQuery(registryQuery(ws));
  const open = threads?.filter((x) => x.status === "open").length ?? 0;
  const [tab, setTab] = useState<Tab>("details");
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "details", label: t("drawer.tab.details") },
    { id: "history", label: t("drawer.tab.history") },
    { id: "comments", label: open ? t("drawer.tab.commentsCount", { n: open }) : t("drawer.tab.comments") },
  ];
  // Arrow keys move between tabs (WAI-ARIA tabs pattern).
  const onTabKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = tabs.findIndex((x) => x.id === tab);
    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    if (next) {
      setTab(next.id);
      document.getElementById(`drawer-tab-${next.id}`)?.focus();
    }
  };
  // A sheet over the grid (not beside it): opening it must not re-lay-out the grid mid-edit.
  return (
    <aside className="fixed bottom-0 right-0 top-16 z-20 flex w-[28rem] max-w-full flex-col gap-4 overflow-y-auto border-l border-border bg-card p-5 shadow-lg" data-testid="envelope-drawer" aria-label={data?.name ?? ""}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold tracking-[-0.015em]" data-testid="drawer-name">
            {data?.name ?? (error ? t("error.title") : t("shell.loading"))}
          </h2>
          {error ? <p className="text-xs text-destructive" data-testid="drawer-error">{error.message}</p> : null}
          {data ? <p className="text-xs text-muted-foreground">{data.status}</p> : null}
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label={t("drawer.close")}>
          <X className="size-4" aria-hidden />
        </Button>
      </div>
      <div role="tablist" aria-label={data?.name ?? ""} className="flex gap-1 border-b border-border" onKeyDown={onTabKey}>
        {tabs.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            id={`drawer-tab-${x.id}`}
            aria-selected={tab === x.id}
            aria-controls={`drawer-panel-${x.id}`}
            tabIndex={tab === x.id ? 0 : -1}
            className={tab === x.id ? "-mb-px border-b-2 border-primary px-3 py-2 text-sm font-medium text-foreground" : "px-3 py-2 text-sm text-muted-foreground hover:text-foreground"}
            onClick={() => setTab(x.id)}
            data-testid={`drawer-tab-${x.id}`}
          >
            {x.label}
          </button>
        ))}
      </div>
      {tab === "history" ? (
        <div role="tabpanel" id="drawer-panel-history" aria-labelledby="drawer-tab-history">
          <HistoryList ws={ws} envelopeId={id} currency={data?.currency ?? "USD"} />
        </div>
      ) : null}
      {tab === "comments" ? (
        <div role="tabpanel" id="drawer-panel-comments" aria-labelledby="drawer-tab-comments">
          <ThreadPanel ws={ws} anchorType="envelope" anchorId={id} canBlock />
        </div>
      ) : null}
      {tab === "details" && data ? (
        <dl role="tabpanel" id="drawer-panel-details" aria-labelledby="drawer-tab-details" className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{t("drawer.approved")}</dt>
          <dd className="tabular text-right font-medium" data-testid="drawer-approved">
            {data.current ? formatMoney(data.current.amount, data.currency) : "—"}
          </dd>
          <dt className="text-muted-foreground">{t("drawer.draft")}</dt>
          <dd className="tabular text-right" data-testid="drawer-draft">
            {data.draft ? formatMoney(data.draft.amount, data.currency) : "—"}
          </dd>
          <dt className="text-muted-foreground">{t("drawer.dates")}</dt>
          <dd className="text-right">
            {data.startDate} – {data.endDate}
          </dd>
          <dt className="col-span-2 pt-2 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">{t("drawer.dimensions")}</dt>
          {Object.entries(data.dimensionValues).map(([k, v]) => {
            const dim = dims.find((d) => d.key === k);
            return (
              <div key={k} className="contents" data-testid="drawer-dimension">
                <dt className="flex items-center gap-1.5 text-muted-foreground">
                  {dim ? <DimensionIcon ws={ws} icon={dim.icon} className="size-3.5" /> : null}
                  {dim?.label ?? k}
                </dt>
                <dd className="text-right">{dim?.values.find((x) => x.code === v)?.label ?? v}</dd>
              </div>
            );
          })}
          <dt className="col-span-2 pt-2 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">{t("tags.title")}</dt>
          <dd className="col-span-2">
            <TagChips ws={ws} entity={{ type: "envelope", id }} tags={data.tags} onChanged={() => client.invalidateQueries({ queryKey: ["envelope", ws, id] })} />
          </dd>
        </dl>
      ) : null}
    </aside>
  );
}
