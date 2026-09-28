import { formatMoney } from "@budget/grid";
import { Button } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Pencil, X } from "lucide-react";
import { useState, type KeyboardEvent, type ReactElement } from "react";
import { HistoryList } from "../history/history-list.js";
import { threadsQuery } from "../threads/queries.js";
import { TagChips } from "../threads/tag-chips.js";
import { ThreadPanel } from "../threads/thread-panel.js";
import { envelopeQuery, registryQuery } from "../../lib/queries.js";
import { api, unwrap } from "../../lib/api.js";
import { STATUS_LABELS } from "./labels.js";
import { DimensionIcon } from "../registry/dimension-icon.js";
import type { StructureOp } from "../structure/structure-dialog.js";
import { StructureActions } from "../structure/structure-actions.js";
import { SendForApproval } from "./send-for-approval.js";
import { FamilySumLine, familyQuery } from "./family-editor.js";

type Tab = "details" | "history" | "comments";

/**
 * The envelope drawer (`select` search param): Details (approved budget, open draft, dimensions,
 * tags), History (every change, T-029) and Comments (threads, T-030). Every budget always has all three.
 */
export function EnvelopeDrawer({ ws, id, onClose, onStructure, onFamily, onChanged }: { ws: string; id: string; onClose: () => void; onStructure?: (op: StructureOp) => void; onFamily?: (id: string) => void; onChanged?: () => void }): ReactElement {
  const client = useQueryClient();
  const { data, error } = useQuery(envelopeQuery(ws, id));
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState("");
  const rename = useMutation({
    mutationFn: async (body: { name: string } | { useTemplateName: true }) => unwrap(api.PATCH("/api/v1/envelopes/{id}", { params: { path: { id }, header: { "X-Workspace-Id": ws } }, body: { rowVersion: data?.rowVersion ?? 1, ...body } as never })),
    onSuccess: async () => {
      setRenaming(false);
      await client.invalidateQueries({ queryKey: ["envelope", ws, id] });
      onChanged?.();
    },
  });
  const { data: threads } = useQuery(threadsQuery(ws, "envelope", id));
  const { data: dims = [] } = useQuery(registryQuery(ws));
  const open = threads?.filter((x) => x.status === "open").length ?? 0;
  const hasChildren = (data?.structure.children.length ?? 0) > 0;
  const { data: family } = useQuery({ ...familyQuery(ws, id), enabled: hasChildren });
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
          {data && renaming ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (newName.trim()) rename.mutate({ name: newName.trim() });
              }}
              data-testid="drawer-rename-form"
            >
              <input className="h-8 min-w-0 flex-1 rounded-md border border-input bg-card px-2 text-sm" aria-label={t("drawer.renameLabel")} value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus data-testid="drawer-rename-input" />
              {newName.trim() && !rename.isPending ? (
                <Button type="submit" size="sm" data-testid="drawer-rename-save">{t("drawer.renameSave")}</Button>
              ) : (
                <Button type="button" size="sm" disabled reason={rename.isPending ? t("shell.loading") : t("drawer.renameNeed")}>{t("drawer.renameSave")}</Button>
              )}
              <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(false)}>{t("drawer.renameCancel")}</Button>
            </form>
          ) : (
            <div className="flex items-center gap-1">
              <h2 className="truncate text-lg font-semibold tracking-[-0.015em]" data-testid="drawer-name">
                {(typeof data?.["displayName"] === "string" ? data["displayName"] : null) ?? data?.name ?? (error ? t("error.title") : t("shell.loading"))}
              </h2>
              {data ? (
                <button type="button" className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={t("drawer.rename")} title={t("drawer.rename")} onClick={() => (setNewName(data.name), setRenaming(true))} data-testid="drawer-rename">
                  <Pencil className="size-3.5" aria-hidden />
                </button>
              ) : null}
            </div>
          )}
          {typeof data?.["displayName"] === "string" && data["displayName"] !== data.name ? <p className="truncate text-xs text-muted-foreground" data-testid="drawer-original-name">{data.name}</p> : null}
          {data?.["nameCustom"] === true ? (
            <p className="text-xs text-muted-foreground">
              {t("drawer.customName")}{" "}
              <button type="button" className="text-primary hover:underline" onClick={() => rename.mutate({ useTemplateName: true })} data-testid="drawer-use-template-name">{t("drawer.useTemplateName")}</button>
            </p>
          ) : null}
          {error ? <p className="text-xs text-destructive" data-testid="drawer-error">{error.message}</p> : null}
          {rename.error ? <p className="text-xs text-destructive" role="alert">{rename.error.message}</p> : null}
          {data ? (
            <span className="mt-1 inline-flex rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground" title={t(`status.help.${data.status}` as MessageKey)} data-testid="drawer-status">
              {STATUS_LABELS()[data.status] ?? data.status}
            </span>
          ) : null}
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label={t("drawer.close")}>
          <X className="size-4" aria-hidden />
        </Button>
      </div>
      {data ? <SendForApproval ws={ws} envelopeId={id} /> : null}
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
          <dt className="col-span-2 pt-2 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">{t("structure.title")}</dt>
          <dd className="col-span-2 flex flex-col gap-2" data-testid="drawer-structure">
            <p className="text-sm">
              <span className="text-muted-foreground">{t("structure.parent")} </span>
              {data.structure.parent ? (
                <Link to="/w/$ws/budgets" params={{ ws }} search={(prev: Record<string, unknown>) => ({ ...prev, select: data.structure.parent?.id })} className="font-medium hover:text-primary" data-testid="drawer-parent">
                  {data.structure.parent.name}
                </Link>
              ) : (
                <span>{t("structure.topLevel")}</span>
              )}
            </p>
            {data.structure.children.length ? (
              <ul className="flex flex-col gap-0.5 text-sm" aria-label={t("structure.children")} data-testid="drawer-children">
                {data.structure.children.map((c) => (
                  <li key={c.id} className="flex items-center gap-2" data-testid="drawer-child">
                    <Link to="/w/$ws/budgets" params={{ ws }} search={(prev: Record<string, unknown>) => ({ ...prev, select: c.id })} className="min-w-0 flex-1 truncate hover:text-primary">
                      {c.name}
                    </Link>
                    <span className="tabular text-xs text-muted-foreground">{c.approved ? formatMoney(c.approved, c.currency) : t(`drawer.status.${c.status.toLowerCase()}` as "drawer.status.draft")}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">{t("structure.noChildren")}</p>
            )}
            {hasChildren ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2">
                {family?.sums[0] ? <FamilySumLine sum={family.sums[0]} currency={data.currency} testId="drawer-family-sum" /> : <span className="text-sm text-muted-foreground">{t("shell.loading")}</span>}
                {onFamily ? (
                  <Button size="sm" variant="outline" onClick={() => onFamily(id)} data-testid="drawer-family-edit">
                    {t("family.edit")}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {onStructure ? <StructureActions env={data} onPick={onStructure} compact /> : null}
          </dd>
          <dt className="col-span-2 pt-2 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">{t("tags.title")}</dt>
          <dd className="col-span-2">
            <TagChips ws={ws} entity={{ type: "envelope", id }} tags={data.tags} onChanged={() => client.invalidateQueries({ queryKey: ["envelope", ws, id] })} />
          </dd>
        </dl>
      ) : null}
    </aside>
  );
}
