import { Button, cn } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useState, type ReactElement } from "react";
import { z } from "zod";
import { Card, Page } from "../components/page.js";
import { formatTarget, targetVersionsQuery, targetsQuery, type TargetRow } from "../features/targets/queries.js";
import { threadsQuery } from "../features/threads/queries.js";
import { ThreadPanel } from "../features/threads/thread-panel.js";
import { api, unwrap } from "../lib/api.js";
import { meQuery } from "../lib/queries.js";

/**
 * Targets (spec §18.5, §10): every active target with its current value and any open draft. The
 * drawer (`select`) has the versions (none is ever overwritten), a form to propose a new value
 * (a draft, then submit for approval), and the target's comments.
 */
const TargetsSearch = z.object({ metric: z.string().optional(), select: z.string().uuid().optional() });
type TargetsSearch = z.infer<typeof TargetsSearch>;

export const Route = createFileRoute("/w/$ws/targets")({
  validateSearch: TargetsSearch,
  component: TargetsPage,
});

function TargetsPage(): ReactElement {
  const { ws } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data, isPending, error } = useQuery(targetsQuery(ws));
  const metrics = [...new Set((data ?? []).map((r) => r.metricKey))].sort();
  const rows = (data ?? []).filter((r) => !search.metric || r.metricKey === search.metric);
  const selected = data?.find((r) => r.id === search.select) ?? null;
  const set = (s: { metric?: string | undefined; select?: string | undefined }) => void navigate({ search: (prev: TargetsSearch) => ({ ...prev, ...s }) });

  return (
    <Page title={t("nav.targets")}>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("targets.metric")} data-testid="target-metrics">
        {[undefined, ...metrics].map((m) => (
          <button key={m ?? "all"} type="button" aria-pressed={search.metric === m} className={cn("h-8 rounded-full border px-3 text-sm", search.metric === m ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card hover:bg-accent")} onClick={() => set({ metric: m, select: undefined })}>
            {m ? m.toUpperCase() : t("targets.all")}
          </button>
        ))}
      </div>
      <Card>
        {error ? <p className="text-sm text-destructive" role="alert">{error.message}</p> : null}
        {isPending ? (
          <p className="text-sm text-muted-foreground">{t("shell.loading")}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="targets-empty">{t("targets.empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="tabular w-full text-sm" data-testid="targets-table">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 font-medium">{t("targets.col.metric")}</th>
                  <th className="py-2 pr-3 font-medium">{t("targets.col.scope")}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t("targets.col.target")}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t("targets.col.draft")}</th>
                  <th className="py-2 font-medium">{t("targets.col.dates")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={cn("cursor-pointer border-t border-border hover:bg-accent/50", r.id === search.select ? "bg-secondary" : "")} onClick={() => set({ select: r.id })} data-testid="target-row">
                    <td className="py-2 pr-3 font-medium">
                      <button type="button" className="hover:text-primary" onClick={() => set({ select: r.id })} aria-label={t("targets.open", { metric: r.metricKey.toUpperCase(), scope: scopeLabel(r) })}>
                        {r.metricKey.toUpperCase()}
                      </button>
                    </td>
                    <td className="py-2 pr-3">{scopeLabel(r)}</td>
                    <td className="whitespace-nowrap py-2 pr-3 text-right">{r.current ? formatTarget(r.current) : "—"}</td>
                    <td className="whitespace-nowrap py-2 pr-3 text-right text-muted-foreground">{r.draft ? `${formatTarget(r.draft)} · ${r.draft.status.toLowerCase()}` : "—"}</td>
                    <td className="whitespace-nowrap py-2 text-muted-foreground">{r.startDate} – {r.endDate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {selected ? <TargetDrawer ws={ws} target={selected} onClose={() => set({ select: undefined })} /> : null}
    </Page>
  );
}

const scopeLabel = (r: TargetRow) => (r.scopeType === "envelope" ? (r.envelopeName ?? "—") : t("targets.scope.filter"));

type Tab = "versions" | "comments";

function TargetDrawer({ ws, target, onClose }: { ws: string; target: TargetRow; onClose: () => void }): ReactElement {
  const [tab, setTab] = useState<Tab>("versions");
  const { data: threads } = useQuery(threadsQuery(ws, "target", target.id));
  const open = threads?.filter((x) => x.status === "open").length ?? 0;
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "versions", label: t("drawer.versions") },
    { id: "comments", label: open ? t("drawer.tab.commentsCount", { n: open }) : t("drawer.tab.comments") },
  ];
  return (
    <aside className="fixed bottom-0 right-0 top-16 z-20 flex w-[28rem] max-w-full flex-col gap-4 overflow-y-auto border-l border-border bg-card p-5 shadow-lg" aria-label={target.metricKey} data-testid="target-drawer">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold tracking-[-0.015em]">
            {target.metricKey.toUpperCase()} · {scopeLabel(target)}
          </h2>
          <p className="text-xs text-muted-foreground">
            {target.current ? formatTarget(target.current) : "—"} · {target.startDate} – {target.endDate}
          </p>
          {target.envelopeId ? (
            <Link to="/w/$ws/budgets" params={{ ws }} search={{ select: target.envelopeId } as never} className="text-xs text-primary hover:underline">
              {t("targets.openBudget")}
            </Link>
          ) : null}
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label={t("drawer.close")}>
          <X className="size-4" aria-hidden />
        </Button>
      </div>
      <div role="tablist" className="flex gap-1 border-b border-border">
        {tabs.map((x) => (
          <button key={x.id} type="button" role="tab" id={`target-tab-${x.id}`} aria-selected={tab === x.id} aria-controls={`target-panel-${x.id}`} className={tab === x.id ? "-mb-px border-b-2 border-primary px-3 py-2 text-sm font-medium" : "px-3 py-2 text-sm text-muted-foreground hover:text-foreground"} onClick={() => setTab(x.id)} data-testid={`target-tab-${x.id}`}>
            {x.label}
          </button>
        ))}
      </div>
      {tab === "versions" ? (
        <div role="tabpanel" id="target-panel-versions" aria-labelledby="target-tab-versions" className="flex flex-col gap-4">
          <ProposeValue ws={ws} target={target} />
          <Versions ws={ws} id={target.id} />
        </div>
      ) : (
        <div role="tabpanel" id="target-panel-comments" aria-labelledby="target-tab-comments">
          <ThreadPanel ws={ws} anchorType="target" anchorId={target.id} canBlock />
        </div>
      )}
    </aside>
  );
}

function Versions({ ws, id }: { ws: string; id: string }): ReactElement {
  const { data } = useQuery(targetVersionsQuery(ws, id));
  if (!data) return <p className="text-sm text-muted-foreground">{t("shell.loading")}</p>;
  return (
    <ol className="flex flex-col gap-2" aria-label={t("drawer.versions")} data-testid="target-versions">
      {data.versions.map((v) => (
        <li key={v.id} className="rounded-lg border border-border px-3 py-2 text-sm" data-testid="target-version">
          <div className="flex items-center gap-2">
            <span className="font-medium">v{v.versionNo}</span>
            <span className="tabular">{formatTarget(v)}</span>
            <span className="ml-auto rounded-full bg-surface px-2 py-0.5 text-xs">{v.status.toLowerCase()}</span>
          </div>
          {v.rationale ? <p className="mt-1 text-xs text-muted-foreground">{v.rationale}</p> : null}
          <time className="block text-xs text-muted-foreground" dateTime={v.createdAt}>{new Date(v.createdAt).toLocaleString()}</time>
        </li>
      ))}
    </ol>
  );
}

/** A new value is a new draft version, then a submit (targets are never edited in place). */
function ProposeValue({ ws, target }: { ws: string; target: TargetRow }): ReactElement {
  const client = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const perms = me?.workspaces.find((w) => w.workspaceId === ws)?.permissions ?? [];
  const base = target.draft ?? target.current;
  const [value, setValue] = useState(base?.value ?? "");
  const [comparator, setComparator] = useState(base?.comparator ?? "lte");
  const [upper, setUpper] = useState(base?.valueUpper ?? "");
  const [rationale, setRationale] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const H = { params: { path: { id: target.id }, header: { "X-Workspace-Id": ws } } };
  const propose = useMutation({
    mutationFn: async () => {
      const draft = (await unwrap(api.PATCH("/api/v1/targets/{id}/draft", { ...H, body: { basedOnVersionId: target.currentVersionId, value, comparator, ...(comparator === "between" ? { valueUpper: upper } : {}), ...(rationale.trim() ? { rationale: rationale.trim() } : {}) } as never }))) as unknown as { id: string };
      return (await unwrap(api.POST("/api/v1/targets/{id}/submit", { ...H, body: { versionId: draft.id } as never }))) as unknown as { autoApproved?: boolean };
    },
    onSuccess: async (res) => {
      setDone(t(res.autoApproved ? "targets.applied" : "targets.submitted"));
      setRationale("");
      await client.invalidateQueries({ queryKey: ["targets", ws] });
      await client.invalidateQueries({ queryKey: ["target-versions", ws, target.id] });
    },
  });
  const valid = /^-?\d{1,14}(\.\d{1,4})?$/.test(value) && (comparator !== "between" || /^-?\d{1,14}(\.\d{1,4})?$/.test(upper));
  const why = !perms.includes("target.edit_draft") ? t("targets.noPermission") : !valid ? t("targets.invalid") : propose.isPending ? t("shell.loading") : null;
  const field = "h-9 rounded-lg border border-input bg-card px-2 text-sm outline-none focus:border-ring";
  return (
    <form
      className="flex flex-col gap-2 rounded-lg border border-border p-3"
      aria-label={t("targets.propose")}
      onSubmit={(e) => {
        e.preventDefault();
        if (!why) propose.mutate();
      }}
      data-testid="target-propose"
    >
      <span className="text-sm font-medium">{t("targets.propose")}</span>
      <div className="flex gap-2">
        <select className={field} value={comparator} onChange={(e) => setComparator(e.target.value)} aria-label={t("targets.comparator")}>
          {["lte", "gte", "eq", "between"].map((c) => (
            <option key={c} value={c}>
              {t(`targets.comparator.${c}` as "targets.comparator.lte")}
            </option>
          ))}
        </select>
        <input className={cn(field, "w-28 text-right")} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} aria-label={t("targets.value")} data-testid="target-value" />
        {comparator === "between" ? <input className={cn(field, "w-28 text-right")} inputMode="decimal" value={upper} onChange={(e) => setUpper(e.target.value)} aria-label={t("targets.valueUpper")} /> : null}
      </div>
      <input className={field} value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder={t("targets.rationale")} aria-label={t("targets.rationale")} />
      {done ? <p role="status" className="text-xs text-success" data-testid="target-done">{done}</p> : null}
      {propose.error ? <p role="alert" className="text-xs text-destructive">{propose.error.message}</p> : null}
      <div className="flex justify-end">
        {why ? (
          <Button size="sm" disabled reason={why} data-testid="target-submit">
            {t("targets.submit")}
          </Button>
        ) : (
          <Button size="sm" type="submit" data-testid="target-submit">
            {t("targets.submit")}
          </Button>
        )}
      </div>
    </form>
  );
}
