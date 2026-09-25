import { formatMoney } from "@budget/grid";
import { Button } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useState, type KeyboardEvent, type ReactElement } from "react";
import { HistoryList } from "../history/history-list.js";
import { envelopeQuery } from "../../lib/queries.js";

/** The envelope drawer (`select` search param): identity, approved budget, open draft, dimensions. */
export function EnvelopeDrawer({ ws, id, onClose }: { ws: string; id: string; onClose: () => void }): ReactElement {
  const { data, error } = useQuery(envelopeQuery(ws, id));
  const [tab, setTab] = useState<"details" | "history">("details");
  const tabs = [
    { id: "details", label: t("drawer.tab.details") },
    { id: "history", label: t("drawer.tab.history") },
  ] as const;
  // Arrow keys move between tabs (WAI-ARIA tabs pattern).
  const onTabKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    setTab((cur) => (cur === "details" ? "history" : "details"));
  };
  // A sheet over the grid (not beside it): opening it must not re-lay-out the grid mid-edit.
  return (
    <aside className="fixed bottom-0 right-0 top-16 z-20 flex w-96 flex-col gap-4 overflow-y-auto border-l border-border bg-card p-5 shadow-lg" data-testid="envelope-drawer" aria-label={data?.name ?? ""}>
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
          {Object.entries(data.dimensionValues).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="text-right">{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </aside>
  );
}
