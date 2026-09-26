import { formatMoney } from "@budget/grid";
import { Button, cn } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Lock, LockOpen } from "lucide-react";
import { useState, type ReactElement } from "react";
import { z } from "zod";
import { Card, Page } from "../components/page.js";
import { can, closureReportQuery, closuresQuery, type Closure } from "../features/ops/queries.js";
import { api, unwrap } from "../lib/api.js";
import { meQuery } from "../lib/queries.js";

/**
 * Closures (spec §18.5, §15): closing a fiscal period locks every live budget in it and freezes
 * its budget-vs-actual report; a restatement (admin, with a reason) unlocks them, and the next
 * close writes a new version of the report. The report of a closure is what was frozen.
 */
const ClosuresSearch = z.object({ select: z.string().uuid().optional() });
type ClosuresSearch = z.infer<typeof ClosuresSearch>;
export const Route = createFileRoute("/w/$ws/closures")({ validateSearch: ClosuresSearch, component: ClosuresPage });

const PERIOD = /^(FY\d{4}|\d{4}-Q[1-4]|\d{4}-(0[1-9]|1[0-2]))$/;

function ClosuresPage(): ReactElement {
  const { ws } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const client = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const perms = me?.workspaces.find((w) => w.workspaceId === ws)?.permissions ?? [];
  const isOrgAdmin = me?.isOrgAdmin ?? false;
  const { data: closures = [], isPending } = useQuery(closuresQuery(ws));
  const set = (s: Partial<ClosuresSearch>) => void navigate({ search: (prev: ClosuresSearch) => ({ ...prev, ...s }) });
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ["closures", ws] });
    await client.invalidateQueries({ queryKey: ["closure-report", ws] });
    await client.invalidateQueries({ queryKey: ["envelope", ws] });
  };
  const selected = closures.find((c) => c.id === search.select) ?? null;

  return (
    <Page title={t("nav.closures")}>
      <div className="grid gap-5 lg:grid-cols-[1fr_24rem]">
        <div className="flex flex-col gap-5">
          <Card>
            {isPending ? (
              <p className="text-sm text-muted-foreground">{t("shell.loading")}</p>
            ) : closures.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="closures-empty">{t("closures.empty")}</p>
            ) : (
              <table className="w-full text-sm" data-testid="closures-table">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3 font-medium">{t("closures.col.period")}</th>
                    <th className="py-2 pr-3 font-medium">{t("closures.col.status")}</th>
                    <th className="py-2 pr-3 text-right font-medium">{t("closures.col.locked")}</th>
                    <th className="py-2 font-medium">{t("closures.col.closed")}</th>
                  </tr>
                </thead>
                <tbody>
                  {closures.map((c) => (
                    <tr key={c.id} className={cn("cursor-pointer border-t border-border hover:bg-accent/50", c.id === search.select ? "bg-secondary" : "")} onClick={() => set({ select: c.id })} data-testid="closure-row" data-period={c.period.key}>
                      <td className="py-2 pr-3">
                        <button type="button" className="font-medium hover:text-primary" onClick={() => set({ select: c.id })}>
                          {c.period.key}
                        </button>
                        <div className="text-xs text-muted-foreground">
                          {c.period.start} – {c.period.end}
                        </div>
                      </td>
                      <td className="py-2 pr-3">
                        <StatusChip status={c.status} />
                      </td>
                      <td className="tabular py-2 pr-3 text-right">{c.lockedEnvelopes}</td>
                      <td className="py-2 text-muted-foreground">{new Date(c.closedAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          {selected ? <Report ws={ws} closure={selected} canRestate={can(perms, isOrgAdmin, "closure.restate")} onChanged={refresh} /> : null}
        </div>
        <Card title={t("closures.close")}>
          <CloseForm ws={ws} canClose={can(perms, isOrgAdmin, "closure.close")} onClosed={async (id) => (await refresh(), set({ select: id }))} />
        </Card>
      </div>
    </Page>
  );
}

function StatusChip({ status }: { status: string }): ReactElement {
  const closed = status === "closed";
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", closed ? "bg-secondary text-secondary-foreground" : "bg-surface")} data-testid="closure-status">
      {closed ? <Lock className="size-3" aria-hidden /> : <LockOpen className="size-3" aria-hidden />}
      {t(closed ? "closures.status.closed" : "closures.status.restated")}
    </span>
  );
}

function CloseForm({ ws, canClose, onClosed }: { ws: string; canClose: boolean; onClosed: (id: string) => Promise<void> }): ReactElement {
  const [key, setKey] = useState("");
  const [confirming, setConfirming] = useState(false);
  const close = useMutation({
    mutationFn: async () => z.object({ id: z.string() }).passthrough().parse(await unwrap(api.POST("/api/v1/workspaces/{ws}/closures", { params: { path: { ws } }, body: { periodKey: key.trim() } as never }))),
    onSuccess: async (c) => {
      setConfirming(false);
      setKey("");
      await onClosed(c.id);
    },
    onError: () => setConfirming(false),
  });
  const why = !canClose ? t("closures.noClose") : !PERIOD.test(key.trim()) ? t("closures.badPeriod") : close.isPending ? t("shell.loading") : null;
  return (
    <div className="flex flex-col gap-3" data-testid="close-form">
      <p className="text-sm text-muted-foreground">{t("closures.closeHelp")}</p>
      <label className="flex flex-col gap-1 text-sm font-medium">
        {t("closures.period")}
        <input className="h-9 rounded-lg border border-input bg-card px-2 font-mono text-sm outline-none focus:border-ring" value={key} onChange={(e) => (setKey(e.target.value.toUpperCase()), setConfirming(false))} placeholder="2026-Q3" data-testid="close-period" />
        <span className="text-xs font-normal text-muted-foreground">{t("closures.periodHelp")}</span>
      </label>
      {close.error ? <p role="alert" className="text-sm text-destructive">{close.error.message}</p> : null}
      {confirming && !why ? (
        <div role="alertdialog" aria-labelledby="close-confirm" className="flex flex-col gap-2 rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm">
          <p id="close-confirm">{t("closures.confirm", { period: key.trim() })}</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              {t("threads.cancel")}
            </Button>
            <Button size="sm" onClick={() => close.mutate()} data-testid="close-confirm">
              {t("closures.closeNow", { period: key.trim() })}
            </Button>
          </div>
        </div>
      ) : why ? (
        <Button disabled reason={why} data-testid="close-submit">
          {t("closures.close")}
        </Button>
      ) : (
        <Button onClick={() => setConfirming(true)} data-testid="close-submit">
          {t("closures.close")}
        </Button>
      )}
    </div>
  );
}

function Report({ ws, closure, canRestate, onChanged }: { ws: string; closure: Closure; canRestate: boolean; onChanged: () => Promise<void> }): ReactElement {
  const { data, isPending } = useQuery(closureReportQuery(ws, closure.id));
  const [reason, setReason] = useState("");
  const restate = useMutation({
    mutationFn: async () => unwrap(api.POST("/api/v1/closures/{id}/restate", { params: { path: { id: closure.id }, header: { "X-Workspace-Id": ws } }, body: { reason: reason.trim() } as never })),
    onSuccess: async () => {
      setReason("");
      await onChanged();
    },
  });
  const s = data?.summary;
  const cur = s?.currency ?? "USD";
  const money = (v: string | null | undefined) => (v === null || v === undefined ? "—" : formatMoney(v, cur));
  const why = !canRestate ? t("closures.noRestate") : closure.status !== "closed" ? t("closures.alreadyRestated") : reason.trim().length < 3 ? t("closures.needReason") : restate.isPending ? t("shell.loading") : null;
  return (
    <Card title={t("closures.report", { period: closure.period.key })}>
      <div className="flex flex-col gap-4" data-testid="closure-report">
        {isPending || !s ? (
          <p className="text-sm text-muted-foreground">{t("shell.loading")}</p>
        ) : (
          <>
            {s.totals ? (
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="closure-totals">
                {(
                  [
                    ["closures.budget", money(s.totals.budget)],
                    ["closures.actual", money(s.totals.actual)],
                    ["closures.variance", money(s.totals.variance)],
                    ["closures.variancePct", s.totals.variancePct === null ? "—" : `${(Number(s.totals.variancePct) * 100).toFixed(1)}%`],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="rounded-lg bg-surface px-3 py-2">
                    <dt className="text-xs text-muted-foreground">{t(label)}</dt>
                    <dd className="tabular text-base font-semibold">{value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            <p className="text-xs text-muted-foreground">{t("closures.frozen", { table: closure.table, rows: s.rows ?? 0, locked: closure.lockedEnvelopes })}</p>
            {(s.byTemplate ?? []).slice(0, 1).map((tpl) => (
              <div key={tpl.templateId} className="overflow-x-auto">
                <p className="mb-1 text-sm font-medium">{t("closures.byTemplate", { name: tpl.name })}</p>
                <table className="tabular w-full text-sm" data-testid="closure-top">
                  <thead className="text-left text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-3 font-medium">{t("closures.node")}</th>
                      <th className="py-1 pr-3 text-right font-medium">{t("closures.budget")}</th>
                      <th className="py-1 pr-3 text-right font-medium">{t("closures.actual")}</th>
                      <th className="py-1 text-right font-medium">{t("closures.variance")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tpl.top.map((n) => (
                      <tr key={n.nodePath} className="border-t border-border">
                        <td className="py-1 pr-3">{n.nodePath || "—"}</td>
                        <td className="py-1 pr-3 text-right">{money(n.budget)}</td>
                        <td className="py-1 pr-3 text-right">{money(n.actual)}</td>
                        <td className={cn("py-1 text-right", n.variance.startsWith("-") ? "text-success" : "text-destructive")}>{money(n.variance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </>
        )}
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t("closures.restateReason")}
            <input className="h-9 rounded-lg border border-input bg-card px-2 text-sm outline-none focus:border-ring" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="restate-reason" />
          </label>
          {restate.error ? <p role="alert" className="text-sm text-destructive">{restate.error.message}</p> : null}
          <div className="flex justify-end">
            {why ? (
              <Button variant="outline" disabled reason={why} data-testid="restate-submit">
                {t("closures.restate")}
              </Button>
            ) : (
              <Button variant="outline" onClick={() => restate.mutate()} data-testid="restate-submit">
                {t("closures.restate")}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
