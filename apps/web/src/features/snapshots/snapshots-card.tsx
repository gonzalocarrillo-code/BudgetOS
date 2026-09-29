import { formatMoney } from "@budget/grid";
import { Button, Chip, Input } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { Card } from "../../components/page.js";
import { savedOn, snapshotsQuery, updateSnapshot, useCanSnapshotWorkspace, type Snapshot } from "./queries.js";

/** Settings › Fiscal calendar › Snapshots (H-007): every snapshot, renamed or archived here; never deleted. */
export function SnapshotsCard({ ws, currency }: { ws: string; currency: string }): ReactElement {
  const [showArchived, setShowArchived] = useState(false);
  const { data: snapshots = [], isPending } = useQuery(snapshotsQuery(ws, { includeArchived: showArchived }));
  const canManage = useCanSnapshotWorkspace(ws);
  return (
    <Card title={t("snapshots.settings.title")}>
      <div className="flex flex-col gap-3 text-sm" data-testid="snapshots-card">
        <div className="flex flex-wrap items-center gap-3">
          <p className="flex-1 text-muted-foreground">
            {t("snapshots.settings.help")}{" "}
            <Link to="/w/$ws/snapshots" params={{ ws }} className="text-primary hover:underline" data-testid="snapshots-open-page">
              {t("snapshots.openPage")}
            </Link>
          </p>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} data-testid="snapshots-show-archived" />
            {t("snapshots.settings.showArchived")}
          </label>
        </div>
        {isPending ? (
          <p className="text-muted-foreground">{t("shell.loading")}</p>
        ) : snapshots.length === 0 ? (
          <p className="text-muted-foreground" data-testid="snapshots-empty">{t("snapshots.settings.empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full" data-testid="snapshots-table">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 font-medium">{t("snapshots.col.name")}</th>
                  <th className="py-2 pr-3 font-medium">{t("snapshots.col.kind")}</th>
                  <th className="py-2 pr-3 font-medium">{t("snapshots.col.saved")}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t("snapshots.col.budgets")}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t("snapshots.col.total")}</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s) => (
                  <SnapshotRow key={s.id} ws={ws} s={s} currency={currency} canManage={canManage} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

function SnapshotRow({ ws, s, currency, canManage }: { ws: string; s: Snapshot; currency: string; canManage: boolean }): ReactElement {
  const client = useQueryClient();
  const [name, setName] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: (body: { name?: string; archived?: boolean }) => updateSnapshot(ws, s.id, body),
    onSuccess: async () => {
      setName(null);
      await client.invalidateQueries({ queryKey: ["snapshots", ws] });
    },
  });
  const why = !canManage ? t("snapshots.onlyFinance") : change.isPending ? t("shell.loading") : null;
  return (
    <tr className="border-t border-border" data-testid="snapshot-row" data-name={s.name}>
      <td className="py-2 pr-3">
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
          </form>
        ) : (
          <span className="font-medium">{s.name}</span>
        )}
        <div className="text-xs text-muted-foreground">{[s.scopeLabel, s.periodKey, s.takenBy?.name].filter(Boolean).join(" · ")}</div>
      </td>
      <td className="py-2 pr-3">
        <span className="inline-flex items-center gap-1">
          <Chip tone={s.kind === "plan" ? "info" : s.kind === "close" ? "success" : "neutral"}>{t(`snapshots.kindShort.${s.kind}`)}</Chip>
          {s.archivedAt ? <Chip>{t("snapshots.archivedChip")}</Chip> : null}
        </span>
      </td>
      <td className="py-2 pr-3 text-muted-foreground">{savedOn(s.asOf)}</td>
      <td className="tabular py-2 pr-3 text-right">{s.rowCount}</td>
      <td className="tabular py-2 pr-3 text-right">{formatMoney(s.total, currency)}</td>
      <td className="py-2">
        <div className="flex justify-end gap-1">
          <Link to="/w/$ws/budgets" params={{ ws }} search={{ compareTo: s.id } as never} className="inline-flex h-8 items-center rounded-md px-2 text-primary hover:underline" data-testid="snapshot-compare">
            {t("snapshots.compare")}
          </Link>
          {why ? (
            <Button size="sm" variant="ghost" disabled reason={why}>{t("snapshots.rename")}</Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setName(s.name)} data-testid="snapshot-rename">{t("snapshots.rename")}</Button>
          )}
          {why ? (
            <Button size="sm" variant="ghost" disabled reason={why}>{s.archivedAt ? t("snapshots.restore") : t("snapshots.archive")}</Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => change.mutate({ archived: s.archivedAt === null })} data-testid="snapshot-archive">
              {s.archivedAt ? t("snapshots.restore") : t("snapshots.archive")}
            </Button>
          )}
        </div>
        {change.error ? <p role="alert" className="text-xs text-destructive">{change.error.message}</p> : null}
      </td>
    </tr>
  );
}
