import { Button, cn } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { CheckCircle2, Clock, Loader2, Play, XCircle } from "lucide-react";
import { useState, type ReactElement } from "react";
import { z } from "zod";
import { Card, Page } from "../components/page.js";
import { can, runsQuery, sourcesQuery, unmatchedQuery, type Run, type Source, type Unmatched } from "../features/ops/queries.js";
import { api, unwrap } from "../lib/api.js";
import { meQuery, searchQuery } from "../lib/queries.js";
import { mappingSummary } from "./w.$ws.admin.sources.js";

/**
 * Sources (spec §18.5, §14): each connector's runs — rows read, accepted and rejected, how much
 * spend matched a budget — with "Run now"; and the unmatched spend, largest first, which a data
 * admin assigns to a budget (every fact with that tuple, inside the budget's dates).
 */
const SourcesSearch = z.object({ source: z.string().uuid().optional() });
type SourcesSearch = z.infer<typeof SourcesSearch>;
export const Route = createFileRoute("/w/$ws/sources/")({ validateSearch: SourcesSearch, component: SourcesPage });

const STATUS_ICON = { ok: CheckCircle2, failed: XCircle, queued: Clock, running: Loader2 } as const;

function RunStatus({ status }: { status: string }): ReactElement {
  const Icon = STATUS_ICON[status as keyof typeof STATUS_ICON] ?? Clock;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", status === "ok" ? "bg-success/15" : status === "failed" ? "bg-destructive/10 text-destructive" : "bg-surface")} data-testid="run-status" data-status={status}>
      <Icon className={cn("size-3.5", status === "running" ? "animate-spin" : "")} aria-hidden />
      {t(`sources.run.${status}` as MessageKey)}
    </span>
  );
}

const coverageOf = (r: Run) => {
  const c = (r.summary?.["matchCoverage"] ?? (r.summary?.["coverage"] as Record<string, unknown> | undefined)?.["matchCoverage"]) as string | number | undefined;
  return c === undefined ? null : `${(Number(c) * 100).toFixed(1)}%`;
};

function SourcesPage(): ReactElement {
  const { ws } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: me } = useQuery(meQuery);
  const perms = me?.workspaces.find((w) => w.workspaceId === ws)?.permissions ?? [];
  const canManage = can(perms, me?.isOrgAdmin ?? false, "source.manage");
  const { data: sources = [], isPending } = useQuery({ ...sourcesQuery(ws), enabled: canManage });
  const selected = sources.find((s) => s.id === search.source) ?? sources[0] ?? null;
  const set = (s: Partial<SourcesSearch>) => void navigate({ search: (prev: SourcesSearch) => ({ ...prev, ...s }) });

  if (!canManage) {
    return (
      <Page title={t("nav.sources")}>
        <Card>
          <p className="text-sm text-muted-foreground">{t("sources.noPermission")}</p>
        </Card>
      </Page>
    );
  }
  return (
    <Page title={t("nav.sources")} actions={<Link to="/w/$ws/admin/sources" params={{ ws }} className="text-sm text-primary hover:underline">{t("sources.setup")}</Link>}>
      <div className="grid gap-5 lg:grid-cols-[18rem_1fr]">
        <Card>
          {isPending ? <p className="text-sm text-muted-foreground">{t("shell.loading")}</p> : null}
          {!isPending && sources.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("sources.none")}{" "}
              <Link to="/w/$ws/admin/sources" params={{ ws }} search={{ wizard: "new" } as never} className="text-primary hover:underline">
                {t("sources.new")}
              </Link>
            </p>
          ) : null}
          <ul className="flex flex-col gap-1" aria-label={t("nav.sources")} data-testid="sources-list">
            {sources.map((s) => (
              <li key={s.id}>
                <button type="button" aria-current={selected?.id === s.id} className={cn("flex w-full flex-col rounded-lg px-3 py-2 text-left text-sm", selected?.id === s.id ? "bg-primary text-primary-foreground" : "hover:bg-accent")} onClick={() => set({ source: s.id })} data-testid="source-item">
                  <span className="font-medium">{s.name}</span>
                  <span className={cn("text-xs", selected?.id === s.id ? "text-primary-foreground/80" : "text-muted-foreground")}>{t(`sources.connector.${s.kind}` as MessageKey)}{s.isActive ? "" : ` · ${t("sources.paused")}`}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
        <div className="flex flex-col gap-5">
          {selected ? <SourceRuns key={selected.id} ws={ws} source={selected} /> : null}
          <UnmatchedSpend ws={ws} />
        </div>
      </div>
    </Page>
  );
}

function SourceRuns({ ws, source }: { ws: string; source: Source }): ReactElement {
  const client = useQueryClient();
  const { data: runs = [], isPending } = useQuery(runsQuery(ws, source.id));
  const run = useMutation({
    mutationFn: async () => unwrap(api.POST("/api/v1/sources/{id}/run", { params: { path: { id: source.id }, header: { "X-Workspace-Id": ws } }, body: {} as never })),
    onSuccess: () => client.invalidateQueries({ queryKey: ["runs", ws, source.id] }),
  });
  const busy = runs.some((r) => r.status === "queued" || r.status === "running");
  const why = !source.isActive ? t("sources.pausedReason") : busy ? t("sources.busy") : run.isPending ? t("shell.loading") : null;
  return (
    <Card title={source.name}>
      <div className="flex flex-col gap-3" data-testid="source-runs">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">{mappingSummary(source.mapping)}</p>
          <div className="ml-auto">
            {why ? (
              <Button size="sm" disabled reason={why} data-testid="source-run">
                <Play className="size-4" aria-hidden />
                {t("sources.runNowButton")}
              </Button>
            ) : (
              <Button size="sm" onClick={() => run.mutate()} data-testid="source-run">
                <Play className="size-4" aria-hidden />
                {t("sources.runNowButton")}
              </Button>
            )}
          </div>
        </div>
        {run.error ? <p role="alert" className="text-sm text-destructive">{run.error.message}</p> : null}
        {isPending ? (
          <p className="text-sm text-muted-foreground">{t("shell.loading")}</p>
        ) : runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("sources.noRuns")}</p>
        ) : (
          <table className="tabular w-full text-sm" data-testid="runs-table">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-2 pr-3 font-medium">{t("sources.run.col.started")}</th>
                <th className="py-2 pr-3 font-medium">{t("sources.run.col.status")}</th>
                <th className="py-2 pr-3 text-right font-medium">{t("sources.run.col.read")}</th>
                <th className="py-2 pr-3 text-right font-medium">{t("sources.run.col.accepted")}</th>
                <th className="py-2 pr-3 text-right font-medium">{t("sources.run.col.rejected")}</th>
                <th className="py-2 text-right font-medium">{t("sources.run.col.coverage")}</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-t border-border" data-testid="run-row">
                  <td className="py-2 pr-3">{new Date(r.startedAt).toLocaleString()}</td>
                  <td className="py-2 pr-3">
                    <RunStatus status={r.status} />
                    {r.status === "failed" && typeof r.summary?.["error"] === "string" ? <div className="mt-1 max-w-sm text-xs text-destructive">{r.summary["error"]}</div> : null}
                  </td>
                  <td className="py-2 pr-3 text-right">{r.rowsRead ?? "—"}</td>
                  <td className="py-2 pr-3 text-right">{r.rowsAccepted ?? "—"}</td>
                  <td className={cn("py-2 pr-3 text-right", r.rowsRejected ? "text-destructive" : "")} data-testid="run-rejected">
                    {r.rowsRejected ?? "—"}
                  </td>
                  <td className="py-2 text-right" data-testid="run-coverage">{coverageOf(r) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Card>
  );
}

function UnmatchedSpend({ ws }: { ws: string }): ReactElement {
  const { data: rows = [], isPending } = useQuery(unmatchedQuery(ws));
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card title={t("sources.unmatched")}>
      <div className="flex flex-col gap-2" data-testid="unmatched">
        <p className="text-xs text-muted-foreground">{t("sources.unmatchedHelp")}</p>
        {isPending ? (
          <p className="text-sm text-muted-foreground">{t("shell.loading")}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="unmatched-empty">{t("sources.unmatchedNone")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {rows.map((u) => {
              const key = JSON.stringify(u.dimensionValues);
              return (
                <li key={key} className="py-2" data-testid="unmatched-row">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{Object.values(u.dimensionValues).join(" · ")}</span>
                    <span className="tabular text-muted-foreground">{t("sources.unmatchedLine", { amount: Number(u.amountReporting).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }), rows: u.rows, from: u.firstDate, to: u.lastDate })}</span>
                    <Button size="sm" variant="outline" className="ml-auto" aria-expanded={open === key} onClick={() => setOpen(open === key ? null : key)} data-testid="unmatched-assign">
                      {t("sources.assign")}
                    </Button>
                  </div>
                  {open === key ? <AssignPicker ws={ws} u={u} onDone={() => setOpen(null)} /> : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}

function AssignPicker({ ws, u, onDone }: { ws: string; u: Unmatched; onDone: () => void }): ReactElement {
  const client = useQueryClient();
  const [q, setQ] = useState(Object.values(u.dimensionValues).join(" "));
  const { data } = useQuery({ ...searchQuery(ws, q.trim(), { types: "envelope", limit: 6 }), enabled: q.trim().length > 1 });
  const hits = data?.groups.find((g) => g.type === "envelope")?.hits ?? [];
  const assign = useMutation({
    mutationFn: async (envelopeId: string) => unwrap(api.POST("/api/v1/workspaces/{ws}/unmatched-spend/map", { params: { path: { ws } }, body: { dimensionValues: u.dimensionValues, envelopeId } as never })),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["unmatched", ws] });
      onDone();
    },
  });
  return (
    <div className="mt-2 flex flex-col gap-1.5 rounded-lg bg-surface p-3" data-testid="assign-picker">
      <input type="search" className="h-8 rounded-md border border-input bg-card px-2 text-sm outline-none focus:border-ring" value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("sources.assignSearch")} placeholder={t("sources.assignSearch")} data-testid="assign-search" />
      <ul className="flex flex-col gap-1">
        {hits.map((h) => (
          <li key={h.id}>
            <button type="button" className="w-full rounded-md px-2 py-1 text-left text-sm hover:bg-accent" onClick={() => assign.mutate(h.id)} data-testid="assign-option">
              <span className="font-medium">{h.title}</span>
              {h.path ? <span className="ml-2 text-xs text-muted-foreground">{h.path}</span> : null}
            </button>
          </li>
        ))}
      </ul>
      {assign.error ? <p role="alert" className="text-xs text-destructive">{assign.error.message}</p> : null}
    </div>
  );
}
