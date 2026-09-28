import { formatChange, formatPctChange } from "@budget/grid";
import { Button, Chip } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Camera } from "lucide-react";
import type { ReactElement } from "react";
import { saveSnapshot, savedOn, snapshotReportQuery, snapshotsQuery, useCanSnapshotWorkspace } from "./queries.js";

/**
 * Closures (H-007): save the period's close as a snapshot by hand, and, once the period has a plan
 * snapshot and a close, how the budget moved from one to the other.
 */
export function ClosureSnapshots({ ws, periodKey }: { ws: string; periodKey: string }): ReactElement {
  const client = useQueryClient();
  const canSave = useCanSnapshotWorkspace(ws);
  const { data: snapshots = [] } = useQuery(snapshotsQuery(ws));
  const forPeriod = snapshots.filter((s) => s.periodKey === periodKey);
  const plan = forPeriod.find((s) => s.kind === "plan") ?? null;
  const close = forPeriod.find((s) => s.kind === "close") ?? null;
  const { data: moved } = useQuery({ ...snapshotReportQuery(ws, plan?.id ?? "", close?.id), enabled: plan !== null && close !== null });
  const save = useMutation({
    meta: { success: t("closures.savedClose", { name: t("closures.closeName", { period: periodKey }) }) },
    mutationFn: () => saveSnapshot(ws, { name: t("closures.closeName", { period: periodKey }), kind: "close", scope: {}, periodKey }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["snapshots", ws] }),
  });
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3" data-testid="closure-snapshots">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-sm font-medium">{t("closures.snapshots")}</p>
        {canSave && !save.isPending ? (
          <Button size="sm" variant="outline" onClick={() => save.mutate()} data-testid="closure-save-close">
            <Camera className="size-4" aria-hidden />
            {t("closures.saveAsClose")}
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled reason={canSave ? t("shell.loading") : t("closures.noSnapshot")}>
            <Camera className="size-4" aria-hidden />
            {t("closures.saveAsClose")}
          </Button>
        )}
      </div>
      {forPeriod.length ? (
        <ul className="flex flex-col gap-1 text-sm">
          {forPeriod.map((s) => (
            <li key={s.id} className="flex items-center gap-2" data-testid="closure-snapshot">
              <Chip tone={s.kind === "plan" ? "info" : s.kind === "close" ? "success" : "neutral"}>{t(`snapshots.kindShort.${s.kind}`)}</Chip>
              <Link to="/w/$ws/budgets" params={{ ws }} search={{ compareTo: s.id } as never} className="min-w-0 flex-1 truncate hover:text-primary">
                {s.name}
              </Link>
              <span className="text-xs text-muted-foreground">{savedOn(s.asOf)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {moved ? (
        <p className="tabular text-sm" data-testid="closure-plan-to-close">
          {t("closures.planToClose", { change: formatChange(moved.change.abs, moved.currency), pct: moved.change.pct === null ? "—" : formatPctChange(moved.change.pct) })}
        </p>
      ) : null}
      {save.error ? <p role="alert" className="text-sm text-destructive">{save.error.message}</p> : null}
    </div>
  );
}
