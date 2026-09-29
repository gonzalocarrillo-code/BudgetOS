import { formatChange, formatMoney, formatPctChange } from "@budget/grid";
import { Button, Chip, cn, EmptyState, Input } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Archive, ArchiveRestore, Camera, Download, GitCompareArrows, Pencil } from "lucide-react";
import { useState, type ReactElement } from "react";
import { z } from "zod";
import { Card, Page } from "../components/page.js";
import { SaveSnapshotDialog } from "../features/snapshots/save-snapshot-dialog.js";
import { downloadSnapshotCsv, savedOn, snapshotReportQuery, snapshotRowsQuery, snapshotsQuery, updateSnapshot, useCanSnapshotWorkspace, type Snapshot } from "../features/snapshots/queries.js";
import { meQuery } from "../lib/queries.js";

/**
 * Snapshots (product feedback round 7, ADR-053): the place to keep, watch and open the snapshots
 * saved by hand. The list is every snapshot; a selected one shows its header, how the budget has
 * moved since (the change report), and what it kept, as the tree it was saved in. Rename, archive,
 * restore, compare in Budgets, download as CSV. Nothing here is ever deleted.
 */
const SnapshotsSearch = z.object({ select: z.string().uuid().optional(), archived: z.boolean().optional() });
type SnapshotsSearch = z.infer<typeof SnapshotsSearch>;
export const Route = createFileRoute("/w/$ws/snapshots")({ validateSearch: SnapshotsSearch, component: SnapshotsPage });

const kindTone = (kind: Snapshot["kind"]) => (kind === "plan" ? "info" : kind === "close" ? "success" : "neutral");

function SnapshotsPage(): ReactElement {
  const { ws } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const set = (s: Partial<SnapshotsSearch>) => void navigate({ search: (prev: SnapshotsSearch) => ({ ...prev, ...s }) });
  const { data: snapshots = [], isPending } = useQuery(snapshotsQuery(ws, { includeArchived: search.archived === true }));
  const { data: me } = useQuery(meQuery);
  const currency = me?.workspaces.find((w) => w.workspaceId === ws)?.currency ?? "USD";
  const [saving, setSaving] = useState(false);
  const selected = snapshots.find((s) => s.id === search.select) ?? null;
  return (
    <Page
      title={t("nav.snapshots")}
      actions={
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" checked={search.archived === true} onChange={(e) => set({ archived: e.target.checked || undefined })} data-testid="snapshots-show-archived" />
            {t("snapshots.settings.showArchived")}
          </label>
          <Button size="sm" onClick={() => setSaving(true)} data-testid="save-snapshot" data-tour="save-snapshot">
            <Camera className="size-4" aria-hidden />
            {t("snapshots.save")}
          </Button>
        </div>
      }
    >
      <p className="max-w-3xl text-sm text-muted-foreground">{t("snapshots.page.help")}</p>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,26rem)_1fr]">
        <Card tour="snapshots-list">
          {isPending ? (
            <p className="text-sm text-muted-foreground">{t("shell.loading")}</p>
          ) : snapshots.length === 0 ? (
            <EmptyState icon={Camera} title={t("snapshots.settings.title")} body={t("snapshots.page.empty")} action={<Button size="sm" onClick={() => setSaving(true)}>{t("snapshots.save")}</Button>} testId="snapshots-empty" />
          ) : (
            <ul className="flex flex-col" aria-label={t("nav.snapshots")} data-testid="snapshots-list">
              {snapshots.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className={cn("flex w-full flex-col gap-1 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent/60", s.id === search.select ? "bg-secondary" : "")}
                    aria-current={s.id === search.select ? "true" : undefined}
                    onClick={() => set({ select: s.id })}
                    data-testid="snapshot-row"
                    data-name={s.name}
                  >
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-medium">{s.name}</span>
                      <Chip tone={kindTone(s.kind)}>{t(`snapshots.kindShort.${s.kind}`)}</Chip>
                      {s.archivedAt ? <Chip>{t("snapshots.archivedChip")}</Chip> : null}
                    </span>
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{savedOn(s.asOf)}</span>
                      {s.periodKey ? <span>· {s.periodKey}</span> : null}
                      {s.scopeLabel ? <span className="truncate">· {s.scopeLabel}</span> : null}
                      <span className="tabular ml-auto">{formatMoney(s.total, currency)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {selected ? <SnapshotDetail ws={ws} snapshot={selected} currency={currency} /> : <Card><p className="text-sm text-muted-foreground" data-testid="snapshots-pick">{t("snapshots.page.pick")}</p></Card>}
      </div>
      {saving ? (
        <SaveSnapshotDialog
          ws={ws}
          onClose={() => setSaving(false)}
          onSaved={(s) => {
            setSaving(false);
            set({ select: s.id });
          }}
        />
      ) : null}
    </Page>
  );
}

function SnapshotDetail({ ws, snapshot: s, currency }: { ws: string; snapshot: Snapshot; currency: string }): ReactElement {
  const client = useQueryClient();
  const canManage = useCanSnapshotWorkspace(ws);
  const [name, setName] = useState<string | null>(null);
  const { data: report } = useQuery(snapshotReportQuery(ws, s.id));
  const { data: tree } = useQuery(snapshotRowsQuery(ws, s.id));
  const change = useMutation({
    mutationFn: (body: { name?: string; archived?: boolean }) => updateSnapshot(ws, s.id, body),
    onSuccess: async (updated) => {
      setName(null);
      await client.invalidateQueries({ queryKey: ["snapshots", ws] });
      await client.invalidateQueries({ queryKey: ["snapshot", ws, s.id] });
      void updated;
    },
  });
  const download = useMutation({ mutationFn: () => downloadSnapshotCsv(ws, s.id, s.name) });
  const why = !canManage ? t("snapshots.onlyFinance") : change.isPending ? t("shell.loading") : null;
  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="snapshot-detail" data-id={s.id}>
      <Card>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-start gap-2">
            <div className="min-w-0 flex-1">
              {name !== null ? (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (name.trim()) change.mutate({ name: name.trim() });
                  }}
                >
                  <Input size="sm" aria-label={t("snapshots.renameLabel", { name: s.name })} value={name} onChange={(e) => setName(e.target.value)} autoFocus data-testid="snapshot-rename-input" />
                  <Button type="submit" size="sm" data-testid="snapshot-rename-save">{t("drawer.renameSave")}</Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setName(null)}>{t("drawer.renameCancel")}</Button>
                </form>
              ) : (
                <h2 className="flex items-center gap-2 text-lg font-semibold tracking-[-0.015em]" data-testid="snapshot-name">
                  {s.name}
                  <Chip tone={kindTone(s.kind)}>{t(`snapshots.kindShort.${s.kind}`)}</Chip>
                  {s.archivedAt ? <Chip>{t("snapshots.archivedChip")}</Chip> : null}
                  {why ? null : (
                    <button type="button" className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={t("snapshots.rename")} title={t("snapshots.rename")} onClick={() => setName(s.name)} data-testid="snapshot-rename">
                      <Pencil className="size-3.5" aria-hidden />
                    </button>
                  )}
                </h2>
              )}
              <p className="text-sm text-muted-foreground">{t("snapshots.savedBy", { date: savedOn(s.createdAt), name: s.takenBy?.name ?? "—" })} · {t("snapshots.asOf", { date: savedOn(s.asOf) })}</p>
              <p className="text-sm text-muted-foreground">{t("snapshots.holds", { count: s.rowCount, total: formatMoney(s.total, currency) })}{s.scopeLabel ? ` · ${t("snapshots.scopeLine", { scope: s.scopeLabel })}` : ""}{s.periodKey ? ` · ${s.periodKey}` : ""}</p>
              {s.note ? <p className="text-sm">{t("snapshots.noteLine", { note: s.note })}</p> : null}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <Link to="/w/$ws/budgets" params={{ ws }} search={{ compareTo: s.id } as never} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-sm font-medium hover:bg-accent" data-testid="snapshot-compare">
                <GitCompareArrows className="size-4" aria-hidden />
                {t("snapshots.compare")}
              </Link>
              {download.isPending ? (
                <Button size="sm" variant="outline" disabled reason={t("shell.loading")}><Download className="size-4" aria-hidden />{t("snapshots.download")}</Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => download.mutate()} data-testid="snapshot-download"><Download className="size-4" aria-hidden />{t("snapshots.download")}</Button>
              )}
              {why ? (
                <Button size="sm" variant="ghost" disabled reason={why}>{s.archivedAt ? <ArchiveRestore className="size-4" aria-hidden /> : <Archive className="size-4" aria-hidden />}{s.archivedAt ? t("snapshots.restore") : t("snapshots.archive")}</Button>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => change.mutate({ archived: s.archivedAt === null })} data-testid="snapshot-archive">
                  {s.archivedAt ? <ArchiveRestore className="size-4" aria-hidden /> : <Archive className="size-4" aria-hidden />}
                  {s.archivedAt ? t("snapshots.restore") : t("snapshots.archive")}
                </Button>
              )}
            </div>
          </div>
          {change.error ? <p role="alert" className="text-sm text-destructive">{change.error.message}</p> : null}
          {download.error ? <p role="alert" className="text-sm text-destructive">{download.error.message}</p> : null}
        </div>
      </Card>
      <Card title={t("snapshots.sinceThen")}>
        {report ? (
          <div className="flex flex-col gap-3" data-testid="snapshot-report">
            <p className="tabular text-base font-semibold">
              {formatChange(report.change.abs, report.currency)}
              {report.change.pct === null ? "" : ` (${formatPctChange(report.change.pct)})`}
              <span className="ml-2 text-sm font-normal text-muted-foreground">{formatMoney(report.baseline.total, report.currency)} → {formatMoney(report.against.total, report.currency)}</span>
            </p>
            <p className="text-sm text-muted-foreground">{t("snapshots.sinceThenBody", { up: report.counts.increased, down: report.counts.decreased, new: report.counts.new, removed: report.counts.removed, ended: report.counts.ended, same: report.counts.unchanged })}</p>
            {report.topMovers.length ? (
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">{t("snapshots.topMovers")}</p>
                <ul className="flex flex-col gap-0.5 text-sm" data-testid="snapshot-movers">
                  {report.topMovers.slice(0, 8).map((m) => (
                    <li key={m.envelopeId} className="flex items-center gap-2">
                      <Link to="/w/$ws/budgets" params={{ ws }} search={{ select: m.envelopeId, compareTo: s.id } as never} className="min-w-0 flex-1 truncate hover:text-primary">{m.name}</Link>
                      {m.status !== "changed" ? <Chip tone={m.status === "new" ? "info" : "neutral"}>{m.status}</Chip> : null}
                      <span className="tabular text-muted-foreground">{formatMoney(m.baseline, report.currency)} → {formatMoney(m.now, report.currency)}</span>
                      <span className={cn("tabular w-28 text-right font-medium", m.abs.startsWith("-") ? "text-muted-foreground" : "text-primary")}>{formatChange(m.abs, report.currency)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("shell.loading")}</p>
        )}
      </Card>
      <Card title={t("snapshots.rows.title")}>
        {tree ? (
          <div className="flex flex-col gap-2">
            {tree.truncated ? <p className="text-xs text-muted-foreground" data-testid="snapshot-rows-truncated">{t("snapshots.rows.truncated", { shown: tree.rows.length, total: s.rowCount })}</p> : null}
            <div className="overflow-x-auto">
              <table className="tabular w-full text-sm" data-testid="snapshot-rows" data-count={tree.rows.length}>
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-1.5 pr-3 font-medium">{t("explorer.col.name")}</th>
                    <th className="py-1.5 pr-3 text-right font-medium">{t("snapshots.rows.then")}</th>
                    <th className="py-1.5 pr-3 text-right font-medium">{t("snapshots.rows.now")}</th>
                    <th className="py-1.5 text-right font-medium">{t("snapshots.rows.change")}</th>
                  </tr>
                </thead>
                <tbody>
                  {tree.rows.map((r) => (
                    <tr key={r.envelopeId} className="border-t border-border" data-testid="snapshot-tree-row" data-depth={r.depth}>
                      <td className="py-1 pr-3">
                        <span className={cn("flex items-center gap-1.5", r.isLeaf ? "" : "font-medium")} style={{ paddingLeft: `${r.depth * 1.25}rem` }}>
                          <Link to="/w/$ws/budgets" params={{ ws }} search={{ select: r.envelopeId, compareTo: s.id } as never} className="truncate hover:text-primary">{r.name}</Link>
                          {r.now === null ? <Chip>{t("snapshots.rows.gone")}</Chip> : r.ended ? <Chip>{t("status.ENDED")}</Chip> : null}
                        </span>
                      </td>
                      <td className="py-1 pr-3 text-right">{formatMoney(r.amountReporting, tree.currency)}</td>
                      <td className="py-1 pr-3 text-right">{r.now === null ? "—" : formatMoney(r.now, tree.currency)}</td>
                      <td className={cn("py-1 text-right", r.change === "0.00" ? "text-muted-foreground" : "")}>{formatChange(r.change, tree.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("shell.loading")}</p>
        )}
      </Card>
    </div>
  );
}
