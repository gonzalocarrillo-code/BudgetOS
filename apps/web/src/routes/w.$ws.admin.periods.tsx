import type { PeriodRow } from "@budget/domain";
import { Button, cn, Input, Select } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Lock, LockOpen, Plus, Trash2 } from "lucide-react";
import { useState, type ReactElement } from "react";
import { z } from "zod";
import { Card, Page } from "../components/page.js";
import { api, unwrap } from "../lib/api.js";
import { meQuery, periodsQuery } from "../lib/queries.js";
import { SnapshotsCard } from "../features/snapshots/snapshots-card.js";

/**
 * The fiscal calendar (product feedback 7, ADR-041): what a year, a quarter and a month are for
 * this workspace — calendar months or 4-4-5 / 4-5-4 / 5-4-4 weeks — plus custom partitions
 * ("Black Friday 2026"). Every screen's "this quarter" and period picker read these rows. Close a
 * period here, or reopen (restate) it; a period with a closure keeps its dates.
 */
export const Route = createFileRoute("/w/$ws/admin/periods")({ component: PeriodsPage });

const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2026, i, 1)).toLocaleString("en", { month: "long", timeZone: "UTC" }));
const PATTERNS = ["calendar", "445", "454", "544"] as const;
const field = "";

/** The fiscal year a period belongs to: the FY row that contains its start. */
function yearOf(p: PeriodRow, years: PeriodRow[]): string {
  return years.find((y) => y.start <= p.start && y.end >= p.start)?.key ?? t("periods.otherYear");
}

function PeriodsPage(): ReactElement {
  const { ws } = Route.useParams();
  const client = useQueryClient();
  const { data: periods = [], error } = useQuery(periodsQuery(ws));
  const { data: me } = useQuery(meQuery);
  const perms = me?.workspaces.find((w) => w.workspaceId === ws)?.permissions ?? [];
  const can = (action: string) => me?.isOrgAdmin === true || perms.includes(action);
  const [problem, setProblem] = useState<string | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ["periods", ws] });
  const act = useMutation({
    meta: { success: t("toast.periodUpdated") },
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => (setProblem(null), refresh()),
    onError: (e: Error) => setProblem(e.message),
  });

  const years = periods.filter((p) => p.kind === "year");
  const groups = new Map<string, PeriodRow[]>();
  for (const p of periods.filter((x) => x.kind !== "year")) groups.set(yearOf(p, years), [...(groups.get(yearOf(p, years)) ?? []), p]);

  const close = (p: PeriodRow) => act.mutate(() => unwrap(api.POST("/api/v1/workspaces/{ws}/closures", { params: { path: { ws } }, body: { periodId: p.id } as never })));
  const reopen = (p: PeriodRow) => {
    const reason = window.prompt(t("periods.reopenReason", { key: p.key }));
    if (reason && reason.trim().length >= 3 && p.closure) act.mutate(() => unwrap(api.POST("/api/v1/closures/{id}/restate", { params: { path: { id: p.closure?.id as string }, header: { "X-Workspace-Id": ws } }, body: { reason } as never })));
  };
  const remove = (p: PeriodRow) => act.mutate(() => unwrap(api.DELETE("/api/v1/periods/{id}", { params: { path: { id: p.id }, header: { "X-Workspace-Id": ws } } })));

  return (
    <Page title={t("admin.periods")}>
      <p className="max-w-3xl text-sm text-muted-foreground">{t("periods.intro")}</p>
      {error ? <p role="alert" className="text-sm text-destructive">{error.message}</p> : null}
      {problem ? <p role="alert" className="text-sm text-destructive" data-testid="periods-error">{problem}</p> : null}
      <div className="grid gap-5 lg:grid-cols-2">
        <FiscalYearCard ws={ws} canManage={can("registry.manage")} onDone={refresh} />
        <CustomPeriodCard ws={ws} canManage={can("registry.manage")} onDone={refresh} />
      </div>
      {[...years].reverse().map((y) => (
        <Card key={y.id} title={`${y.key} · ${y.start} – ${y.end}`}>
          <table className="w-full text-sm" data-testid="period-year" data-key={y.key}>
            <tbody>
              {[y, ...(groups.get(y.key) ?? [])].map((p) => (
                <tr key={p.id} className="border-t border-border first:border-t-0" data-testid="period" data-key={p.key} data-closure={p.closure?.status ?? "open"}>
                  <td className={cn("py-2 pr-3 font-medium", p.kind === "month" && "pl-6 font-normal", p.kind === "quarter" && "pl-3")}>{p.key}</td>
                  <td className="py-2 pr-3"><span className="rounded-md bg-secondary px-2 py-0.5 text-xs">{t(`periods.kind.${p.kind}` as MessageKey)}</span></td>
                  <td className="py-2 pr-3 tabular-nums text-muted-foreground">{p.start} – {p.end}</td>
                  <td className="py-2 pr-3">
                    {p.closure?.status === "closed" ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-warning"><Lock className="size-3.5" aria-hidden />{t("periods.closed")}</span>
                    ) : p.closure?.status === "restated" ? (
                      <span className="text-xs text-muted-foreground">{t("periods.restated")}</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">{t("periods.open")}</span>
                    )}
                  </td>
                  <td className="py-2 text-right">
                    <PeriodActions p={p} can={can} onClose={close} onReopen={reopen} onRemove={remove} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}
      {groups.get(t("periods.otherYear"))?.length ? (
        <Card title={t("periods.otherYear")}>
          <ul className="flex flex-col gap-1 text-sm">
            {groups.get(t("periods.otherYear"))?.map((p) => (
              <li key={p.id} className="flex items-center gap-3" data-testid="period" data-key={p.key} data-closure={p.closure?.status ?? "open"}>
                <span className="font-medium">{p.key}</span>
                <span className="tabular-nums text-muted-foreground">{p.start} – {p.end}</span>
                <span className="ml-auto"><PeriodActions p={p} can={can} onClose={close} onReopen={reopen} onRemove={remove} /></span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <SnapshotsCard ws={ws} currency={me?.workspaces.find((w) => w.workspaceId === ws)?.currency ?? "USD"} />
    </Page>
  );
}

function PeriodActions({ p, can, onClose, onReopen, onRemove }: { p: PeriodRow; can: (a: string) => boolean; onClose: (p: PeriodRow) => void; onReopen: (p: PeriodRow) => void; onRemove: (p: PeriodRow) => void }): ReactElement {
  return (
    <span className="inline-flex gap-1">
      {p.closure?.status === "closed" ? (
        can("closure.restate") ? (
          <Button size="sm" variant="ghost" onClick={() => onReopen(p)} data-testid="period-reopen"><LockOpen className="size-3.5" aria-hidden />{t("periods.reopen")}</Button>
        ) : (
          <Button size="sm" variant="ghost" disabled reason={t("periods.noRestate")}><LockOpen className="size-3.5" aria-hidden />{t("periods.reopen")}</Button>
        )
      ) : p.end >= new Date().toISOString().slice(0, 10) ? (
        // A period closes once it has ended (spec §15).
        <Button size="sm" variant="ghost" disabled reason={t("periods.notEnded", { end: p.end })}><Lock className="size-3.5" aria-hidden />{t("periods.close")}</Button>
      ) : can("closure.close") ? (
        <Button size="sm" variant="ghost" onClick={() => onClose(p)} data-testid="period-close"><Lock className="size-3.5" aria-hidden />{t("periods.close")}</Button>
      ) : (
        <Button size="sm" variant="ghost" disabled reason={t("periods.noClose")}><Lock className="size-3.5" aria-hidden />{t("periods.close")}</Button>
      )}
      {p.closure === null && can("registry.manage") ? (
        <Button size="sm" variant="ghost" onClick={() => onRemove(p)} aria-label={t("periods.delete", { key: p.key })} data-testid="period-delete"><Trash2 className="size-3.5" aria-hidden /></Button>
      ) : null}
    </span>
  );
}

function FiscalYearCard({ ws, canManage, onDone }: { ws: string; canManage: boolean; onDone: () => void }): ReactElement {
  const client = useQueryClient();
  const { data: fy } = useQuery({ queryKey: ["fiscal-year", ws], queryFn: async () => z.object({ startMonth: z.number() }).parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/fiscal-year", { params: { path: { ws } } }))) });
  const [year, setYear] = useState(String(new Date().getUTCFullYear() + 1));
  const [pattern, setPattern] = useState<(typeof PATTERNS)[number]>("calendar");
  const [notice, setNotice] = useState<string | null>(null);
  const setStart = useMutation({
    meta: { success: t("toast.fiscalSaved") },
    mutationFn: async (m: number) => unwrap(api.PATCH("/api/v1/workspaces/{ws}/fiscal-year", { params: { path: { ws } }, body: { startMonth: m } as never })),
    // Computed periods and "this quarter" everywhere follow the new start.
    onSuccess: () => void client.invalidateQueries(),
  });
  const generate = useMutation({
    meta: { success: t("toast.periodsGenerated") },
    mutationFn: async () => z.object({ created: z.array(z.string()), kept: z.array(z.string()) }).parse(await unwrap(api.POST("/api/v1/workspaces/{ws}/periods/generate", { params: { path: { ws } }, body: { fiscalYear: Number(year), pattern } as never }))),
    onSuccess: (r) => (setNotice(t("periods.generated", { created: r.created.length, kept: r.kept.length })), onDone()),
  });
  return (
    <Card title={t("periods.fiscalYear")}>
      <div className="flex flex-col gap-4 text-sm">
        <label className="flex items-center justify-between gap-3">
          <span>{t("periods.startMonth")}</span>
          {canManage ? (
            <Select className={field} value={fy?.startMonth ?? ""} onChange={(e) => setStart.mutate(Number(e.target.value))} data-testid="periods-start-month">
            <option value="" hidden>{t("periods.pickMonth")}</option>
            {MONTHS.map((m, i) => (
              <option key={m} value={i + 1}>{m}</option>
            ))}
            </Select>
          ) : (
            <Select className={field} value={fy?.startMonth ?? ""} disabled title={t("periods.noManage")}>
            <option value="" hidden>{t("periods.pickMonth")}</option>
            {MONTHS.map((m, i) => (
              <option key={m} value={i + 1}>{m}</option>
            ))}
            </Select>
          )}
        </label>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">{t("periods.year")}</span>
            <Input className={cn(field, "w-24 tabular-nums")} value={year} onChange={(e) => setYear(e.target.value)} inputMode="numeric" data-testid="periods-year" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">{t("periods.pattern")}</span>
            <Select className={field} value={pattern} onChange={(e) => setPattern(e.target.value as (typeof PATTERNS)[number])} data-testid="periods-pattern">
              {PATTERNS.map((p) => (
                <option key={p} value={p}>{t(`periods.pattern.${p}` as MessageKey)}</option>
              ))}
            </Select>
          </label>
          {canManage && /^\d{4}$/.test(year) && !generate.isPending ? (
            <Button onClick={() => generate.mutate()} data-testid="periods-generate">{t("periods.generate")}</Button>
          ) : (
            <Button disabled reason={canManage ? t("periods.needYear") : t("periods.noManage")}>{t("periods.generate")}</Button>
          )}
        </div>
        {notice ? <p className="text-success" role="status" data-testid="periods-notice">{notice}</p> : null}
        {generate.error ? <p role="alert" className="text-destructive">{generate.error.message}</p> : null}
      </div>
    </Card>
  );
}

function CustomPeriodCard({ ws, canManage, onDone }: { ws: string; canManage: boolean; onDone: () => void }): ReactElement {
  const [key, setKey] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const create = useMutation({
    meta: { success: t("toast.periodCreated") },
    mutationFn: async () => unwrap(api.POST("/api/v1/workspaces/{ws}/periods", { params: { path: { ws } }, body: { key: key.trim(), kind: "custom", start, end } as never })),
    onSuccess: () => (setKey(""), setStart(""), setEnd(""), onDone()),
  });
  const ready = key.trim() !== "" && /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end) && start <= end;
  return (
    <Card title={t("periods.custom")}>
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-muted-foreground">{t("periods.customHelp")}</p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-40 flex-1 flex-col gap-1">
            <span className="text-muted-foreground">{t("periods.name")}</span>
            <Input className={field} value={key} onChange={(e) => setKey(e.target.value)} placeholder="Black Friday 2026" data-testid="custom-key" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">{t("periods.from")}</span>
            <Input type="date" className={field} value={start} onChange={(e) => setStart(e.target.value)} data-testid="custom-start" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">{t("periods.to")}</span>
            <Input type="date" className={field} value={end} onChange={(e) => setEnd(e.target.value)} data-testid="custom-end" />
          </label>
          {canManage && ready && !create.isPending ? (
            <Button onClick={() => create.mutate()} data-testid="custom-add"><Plus className="size-4" aria-hidden />{t("periods.add")}</Button>
          ) : (
            <Button disabled reason={canManage ? t("periods.needCustom") : t("periods.noManage")}><Plus className="size-4" aria-hidden />{t("periods.add")}</Button>
          )}
        </div>
        {create.error ? <p role="alert" className="text-destructive">{create.error.message}</p> : null}
      </div>
    </Card>
  );
}
