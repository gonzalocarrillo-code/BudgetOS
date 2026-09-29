import { formatMoney } from "@budget/grid";
import { Button, cn, Textarea } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Decimal } from "decimal.js";
import { useState, type ReactElement } from "react";
import { Card } from "../../components/page.js";
import { api, unwrap } from "../../lib/api.js";
import type { ApprovalDetail } from "../../lib/queries.js";

/**
 * A request's detail parts (spec §18.5), shared by the request page and Home's decide sheet
 * (HO-007): what changes (DiffTable), the chain and where it stands, every decision by its account
 * (DecisionTimeline), and the DecisionBar, which says why when the caller cannot decide.
 */
export type Decision = "approve" | "reject" | "request_changes";
export const DECISIONS: Array<{ id: Decision; label: MessageKey; variant: "default" | "outline" | "destructive" }> = [
  { id: "approve", label: "approvals.decision.approve", variant: "default" },
  { id: "request_changes", label: "approvals.decision.request_changes", variant: "outline" },
  { id: "reject", label: "approvals.decision.reject", variant: "destructive" },
];
export const decisionText = (d: string) => {
  const key = `approvals.decision.${d}` as MessageKey;
  return t(key) === key ? d : t(key);
};

/**
 * Deciding a request: the comment, the decision call, and what to refresh after it (the request, the
 * inbox, the timeline, Home). `onDecided` runs after a decision lands.
 */
export function useDecision(ws: string, id: string, onDecided?: (decision: Decision) => void) {
  const client = useQueryClient();
  const [comment, setComment] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: async (decision: Decision) => unwrap(api.POST("/api/v1/approvals/{id}/decisions", { params: { path: { id }, header: { "X-Workspace-Id": ws } }, body: { decision, ...(comment.trim() ? { comment: comment.trim() } : {}) } as never })),
    onSuccess: async (_, decision) => {
      setDone(t("approvals.done", { decision: decisionText(decision) }));
      setComment("");
      await Promise.all([
        client.invalidateQueries({ queryKey: ["approval", ws, id] }),
        client.invalidateQueries({ queryKey: ["approvals", ws] }),
        client.invalidateQueries({ queryKey: ["timeline", ws] }),
        client.invalidateQueries({ queryKey: ["home", ws] }),
        client.invalidateQueries({ queryKey: ["overview", ws] }),
      ]);
      onDecided?.(decision);
    },
  });
  return { comment, setComment, done, decide };
}

export function DiffTable({ ws, r, currency }: { ws: string; r: ApprovalDetail; currency: string }): ReactElement {
  return (
    <div className="overflow-x-auto">
      <table className="tabular w-full text-sm" data-testid="diff-table">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-2 pr-3 font-medium">{t("approvals.diff.envelope")}</th>
            <th className="py-2 pr-3 text-right font-medium">{t("approvals.diff.before")}</th>
            <th className="py-2 pr-3 text-right font-medium">{t("approvals.diff.after")}</th>
            <th className="py-2 text-right font-medium">{t("approvals.diff.change")}</th>
          </tr>
        </thead>
        <tbody>
          {r.rows.map((row) => {
            const before = row.approvedAmountReporting;
            const delta = before === null ? null : new Decimal(row.amountReporting).minus(before);
            return (
              <tr key={row.versionId} className="border-t border-border" data-testid="diff-row">
                <td className="py-2 pr-3">
                  <Link to="/w/$ws/budgets" params={{ ws }} search={{ select: row.envelopeId } as never} className="hover:text-primary">
                    {row.envelopeName}
                  </Link>
                  {row.rationale ? <div className="text-xs text-muted-foreground">{row.rationale}</div> : null}
                </td>
                <td className="whitespace-nowrap py-2 pr-3 text-right">{before === null ? "—" : formatMoney(before, currency)}</td>
                <td className="whitespace-nowrap py-2 pr-3 text-right font-medium">{formatMoney(row.amountReporting, currency)}</td>
                <td className={cn("whitespace-nowrap py-2 text-right", delta && delta.isNegative() ? "text-destructive" : "text-success")}>{delta === null ? "—" : `${delta.isNegative() ? "" : "+"}${formatMoney(delta.toFixed(2), currency)}`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Chain({ r }: { r: ApprovalDetail }): ReactElement {
  const open = r.status === "PENDING" || r.status === "ESCALATED";
  return (
    <ol className="flex flex-col gap-2" data-testid="chain">
      {r.policySnapshot.chain.map((step, i) => {
        const current = open && i === r.currentStep;
        const doneStep = i < r.currentStep || r.status === "APPROVED";
        return (
          <li key={i} className={cn("flex items-center justify-between rounded-lg border px-3 py-2 text-sm", current ? "border-primary bg-secondary" : "border-border")} aria-current={current ? "step" : undefined} data-testid="chain-step">
            <span>{t("approvals.step", { n: i + 1, role: step.role.toLowerCase().replace(/_/g, " ") })}</span>
            <span className="text-xs text-muted-foreground">{current ? t("approvals.step.current") : doneStep ? t("approvals.step.done") : ""}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function DecisionTimeline({ r }: { r: ApprovalDetail }): ReactElement {
  return (
    <ol className="flex flex-col gap-3" aria-label={t("approvals.timeline")} data-testid="decision-timeline">
      <li className="text-sm">
        <span className="font-medium">{t("approvals.timeline.requested", { name: r.people[r.requestedBy] ?? "—" })}</span>
        <time className="block text-xs text-muted-foreground" dateTime={r.requestedAt}>{new Date(r.requestedAt).toLocaleString()}</time>
      </li>
      {r.decisions.map((d) => (
        <li key={d.id} className="text-sm" data-testid="decision-entry">
          <span className="font-medium">{t("approvals.decided", { name: r.people[d.decidedBy] ?? "—", decision: decisionText(d.decision) })}</span>
          <span className="ml-1 text-xs text-muted-foreground">· {t("approvals.step", { n: d.stepIndex + 1, role: (r.policySnapshot.chain[d.stepIndex]?.role ?? "").toLowerCase().replace(/_/g, " ") })}</span>
          <time className="block text-xs text-muted-foreground" dateTime={d.decidedAt}>{new Date(d.decidedAt).toLocaleString()}</time>
          {d.comment ? <p className="mt-1 whitespace-pre-line rounded-md bg-surface px-2 py-1" data-testid="decision-comment">{d.comment}</p> : null}
        </li>
      ))}
    </ol>
  );
}

export function DecisionBar({ r, comment, setComment, pending, error, onDecide }: { r: ApprovalDetail; comment: string; setComment: (s: string) => void; pending: boolean; error: string | null; onDecide: (d: Decision) => void }): ReactElement {
  const reason = r.decision.canDecide ? null : r.decision.reason;
  return (
    <Card title={t("approvals.comment")}>
      <div className="flex flex-col gap-3" data-testid="decision-bar">
        <Textarea className="min-h-20" placeholder={t("approvals.comment.placeholder")} aria-label={t("approvals.comment")} value={comment} onChange={(e) => setComment(e.target.value)} data-testid="decision-comment-input" />
        {reason ? <p className="text-sm text-muted-foreground" data-testid="decision-reason">{reason}</p> : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="flex flex-wrap gap-2">
          {DECISIONS.map((d) => {
            const needsComment = d.id !== "approve" && comment.trim() === "";
            const why = reason ?? (pending ? t("shell.loading") : needsComment ? t("approvals.comment.required") : null);
            return why ? (
              <Button key={d.id} variant={d.variant} disabled reason={why} data-testid={`decide-${d.id}`}>
                {t(d.label)}
              </Button>
            ) : (
              <Button key={d.id} variant={d.variant} onClick={() => onDecide(d.id)} data-testid={`decide-${d.id}`}>
                {t(d.label)}
              </Button>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

/** T-039: a manual result batch — the facts it would load, row by row, and the totals. */
export function ManualEntryDiff({ ws, batch }: { ws: string; batch: NonNullable<ApprovalDetail["manualEntry"]> }): ReactElement {
  const kpis = [...new Set(batch.rows.flatMap((row) => Object.keys(row.kpis)))].sort();
  return (
    <div className="flex flex-col gap-3" data-testid="manual-entry-diff">
      <p className="text-sm text-muted-foreground">
        {t("manual.approval.summary", { channel: batch.channel, start: batch.periodStart, end: batch.periodEnd, rows: batch.totals.rows })}{" "}
        <Link to="/w/$ws/sources/manual" params={{ ws }} search={{ channel: batch.channel, batch: batch.id } as never} className="text-primary hover:underline">
          {t("manual.approval.open")}
        </Link>
      </p>
      <div className="overflow-x-auto">
        <table className="tabular w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-2 pr-3 font-medium">#</th>
              <th className="py-2 pr-3 font-medium">{t("manual.col.scope")}</th>
              <th className="py-2 pr-3 font-medium">{t("manual.col.date")}</th>
              <th className="py-2 pr-3 text-right font-medium">{t("manual.col.amount")}</th>
              {kpis.map((k) => (
                <th key={k} className="py-2 pr-3 text-right font-medium">
                  {k}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {batch.rows.map((row) => (
              <tr key={row.rowNo} className="border-t border-border" data-testid="manual-diff-row">
                <td className="py-2 pr-3 text-muted-foreground">{row.rowNo}</td>
                <td className="py-2 pr-3">{Object.entries(row.dimensionValues).map(([k, v]) => `${k}: ${v}`).join(" · ")}</td>
                <td className="py-2 pr-3">{row.periodDate}</td>
                <td className="py-2 pr-3 text-right">{formatMoney(row.amount, row.currency)}</td>
                {kpis.map((k) => (
                  <td key={k} className="py-2 pr-3 text-right">
                    {row.kpis[k] ?? "—"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border font-semibold">
              <td className="py-2 pr-3" colSpan={3}>
                {t("explorer.totals")}
              </td>
              <td className="py-2 pr-3 text-right" data-testid="manual-diff-total">
                {Object.entries(batch.totals.byCurrency).map(([c, v]) => formatMoney(v, c)).join(" + ")}
              </td>
              {kpis.map((k) => (
                <td key={k} />
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
