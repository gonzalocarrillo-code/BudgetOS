import { Dialog, SheetContent, toast } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { Card } from "../../components/page.js";
import { Chain, DecisionBar, DiffTable, ManualEntryDiff, decisionText, useDecision } from "../approvals/detail.js";
import { StatusChip } from "../approvals/parts.js";
import { approvalQuery } from "../../lib/queries.js";

/**
 * Decide from Home (HO-007, decision G4): the request in a side sheet — what changes, the decision
 * bar and the chain — so an approver never leaves Home. The same parts and the same command as the
 * request page, which stays one click away. A decision closes the sheet; the item leaves the list.
 */
export function DecideSheet({ ws, id, onClose }: { ws: string; id: string; onClose: () => void }): ReactElement {
  const { data: r, error } = useQuery(approvalQuery(ws, id));
  const { comment, setComment, decide } = useDecision(ws, id, (d) => {
    toast.success(t("approvals.done", { decision: decisionText(d) }));
    onClose();
  });
  const currency = r?.envelope?.currency ?? "USD";
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent title={r?.summary ?? t("page.approval")} className="max-w-xl" data-testid="decide-sheet">
        {error ? <p role="alert" className="text-sm text-destructive">{error.message}</p> : null}
        {!r ? (
          <p className="text-sm text-muted-foreground">{t("shell.loading")}</p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <StatusChip status={r.status} />
              <span>{t("approvals.timeline.requested", { name: r.people[r.requestedBy] ?? "—" })}</span>
              <Link to="/w/$ws/approvals/$id" params={{ ws, id }} className="ml-auto text-primary hover:underline" data-testid="decide-sheet-open">
                {t("home.decide.full")}
              </Link>
            </div>
            <DecisionBar r={r} comment={comment} setComment={setComment} pending={decide.isPending} error={decide.error?.message ?? null} onDecide={(d) => decide.mutate(d)} />
            <Card title={t("approvals.diff")}>{r.manualEntry ? <ManualEntryDiff ws={ws} batch={r.manualEntry} /> : <DiffTable ws={ws} r={r} currency={currency} />}</Card>
            <Card title={t("approvals.chain")}>
              <Chain r={r} />
            </Card>
          </div>
        )}
      </SheetContent>
    </Dialog>
  );
}
