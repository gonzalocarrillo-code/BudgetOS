import { formatMoney } from "@budget/grid";
import { Button, cn } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Decimal } from "decimal.js";
import { ArrowLeft } from "lucide-react";
import { useState, type ReactElement } from "react";
import { Card, Page } from "../components/page.js";
import { StatusChip } from "../features/approvals/parts.js";
import { HistoryList } from "../features/history/history-list.js";
import { api, unwrap } from "../lib/api.js";
import { approvalQuery, type ApprovalDetail } from "../lib/queries.js";

/**
 * Request detail (spec §18.5): what changes (DiffTable), the chain and where it stands, every
 * decision by its account with its comment (DecisionTimeline), and the DecisionBar. The bar says
 * why when the caller cannot decide (the API's decision.reason).
 */
export const Route = createFileRoute("/w/$ws/approvals/$id")({ component: RequestDetail });

type Decision = "approve" | "reject" | "request_changes";
const DECISIONS: Array<{ id: Decision; label: MessageKey; variant: "default" | "outline" | "destructive" }> = [
  { id: "approve", label: "approvals.decision.approve", variant: "default" },
  { id: "request_changes", label: "approvals.decision.request_changes", variant: "outline" },
  { id: "reject", label: "approvals.decision.reject", variant: "destructive" },
];
const decisionText = (d: string) => {
  const key = `approvals.decision.${d}` as MessageKey;
  return t(key) === key ? d : t(key);
};

function RequestDetail(): ReactElement {
  const { ws, id } = Route.useParams();
  const client = useQueryClient();
  const { data: r } = useQuery(approvalQuery(ws, id));
  const [comment, setComment] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: async (decision: Decision) => unwrap(api.POST("/api/v1/approvals/{id}/decisions", { params: { path: { id }, header: { "X-Workspace-Id": ws } }, body: { decision, ...(comment.trim() ? { comment: comment.trim() } : {}) } as never })),
    onSuccess: async (_, decision) => {
      setDone(t("approvals.done", { decision: decisionText(decision) }));
      setComment("");
      await client.invalidateQueries({ queryKey: ["approval", ws, id] });
      await client.invalidateQueries({ queryKey: ["approvals", ws] });
      await client.invalidateQueries({ queryKey: ["timeline", ws] });
    },
  });
  if (!r) return <Page title={t("page.approval")}><p className="text-sm text-muted-foreground">{t("shell.loading")}</p></Page>;
  const currency = r.envelope?.currency ?? "USD";

  return (
    <Page
      title={r.summary ?? t("page.approval")}
      actions={
        <Link to="/w/$ws/approvals" params={{ ws }} search={{ tab: "mine" }} className="inline-flex items-center gap-1 text-sm text-secondary-foreground hover:underline">
          <ArrowLeft className="size-4" aria-hidden />
          {t("approvals.back")}
        </Link>
      }
    >
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <StatusChip status={r.status} />
        <span>{t("approvals.timeline.requested", { name: r.people[r.requestedBy] ?? "—" })} · {new Date(r.requestedAt).toLocaleString()}</span>
        {r.policySnapshot.policyName ? <span>{t("approvals.policy", { name: r.policySnapshot.policyName })}</span> : null}
      </div>
      {done ? <div role="status" className="rounded-lg border border-success/40 bg-success/10 px-4 py-2 text-sm" data-testid="decision-done">{done}</div> : null}
      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        <div className="flex flex-col gap-5">
          <Card title={t("approvals.diff")}>
            <DiffTable ws={ws} r={r} currency={currency} />
          </Card>
          <DecisionBar r={r} comment={comment} setComment={setComment} pending={decide.isPending} error={decide.error?.message ?? null} onDecide={(d) => decide.mutate(d)} />
          {r.envelope ? (
            <Card title={t("drawer.tab.history")}>
              <HistoryList ws={ws} envelopeId={r.envelope.id} currency={currency} />
            </Card>
          ) : null}
        </div>
        <div className="flex flex-col gap-5">
          <Card title={t("approvals.chain")}>
            <Chain r={r} />
          </Card>
          <Card title={t("approvals.timeline")}>
            <DecisionTimeline r={r} />
          </Card>
        </div>
      </div>
    </Page>
  );
}

function DiffTable({ ws, r, currency }: { ws: string; r: ApprovalDetail; currency: string }): ReactElement {
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
                <td className="py-2 pr-3 text-right">{before === null ? "—" : formatMoney(before, currency)}</td>
                <td className="py-2 pr-3 text-right font-medium">{formatMoney(row.amountReporting, currency)}</td>
                <td className={cn("py-2 text-right", delta && delta.isNegative() ? "text-destructive" : "text-success")}>{delta === null ? "—" : `${delta.isNegative() ? "" : "+"}${formatMoney(delta.toFixed(2), currency)}`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Chain({ r }: { r: ApprovalDetail }): ReactElement {
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

function DecisionTimeline({ r }: { r: ApprovalDetail }): ReactElement {
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

function DecisionBar({ r, comment, setComment, pending, error, onDecide }: { r: ApprovalDetail; comment: string; setComment: (s: string) => void; pending: boolean; error: string | null; onDecide: (d: Decision) => void }): ReactElement {
  const reason = r.decision.canDecide ? null : r.decision.reason;
  return (
    <Card title={t("approvals.comment")}>
      <div className="flex flex-col gap-3" data-testid="decision-bar">
        <textarea className="min-h-20 rounded-lg border border-input bg-card p-2 text-sm outline-none focus:border-ring" placeholder={t("approvals.comment.placeholder")} aria-label={t("approvals.comment")} value={comment} onChange={(e) => setComment(e.target.value)} data-testid="decision-comment-input" />
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
