import { t } from "@budget/ui/i18n";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import type { ReactElement } from "react";
import { Card, Page } from "../components/page.js";
import { Chain, DecisionBar, DecisionTimeline, DiffTable, ManualEntryDiff, useDecision } from "../features/approvals/detail.js";
import { StatusChip } from "../features/approvals/parts.js";
import { HistoryList } from "../features/history/history-list.js";
import { ThreadPanel } from "../features/threads/thread-panel.js";
import { TagChips } from "../features/threads/tag-chips.js";
import { approvalQuery } from "../lib/queries.js";

/**
 * Request detail (spec §18.5): what changes (DiffTable), the chain and where it stands, every
 * decision by its account with its comment (DecisionTimeline), and the DecisionBar. The bar says
 * why when the caller cannot decide (the API's decision.reason).
 */
export const Route = createFileRoute("/w/$ws/approvals/$id")({ component: RequestDetail });

function RequestDetail(): ReactElement {
  const { ws, id } = Route.useParams();
  const { data: r } = useQuery(approvalQuery(ws, id));
  const { comment, setComment, done, decide } = useDecision(ws, id);
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
            {r.manualEntry ? <ManualEntryDiff ws={ws} batch={r.manualEntry} /> : <DiffTable ws={ws} r={r} currency={currency} />}
          </Card>
          <Card title={t("threads.title")}>
            <ThreadPanel ws={ws} anchorType="approval_request" anchorId={r.id} />
          </Card>
          {r.envelope ? (
            <Card title={t("drawer.tab.history")}>
              <HistoryList ws={ws} envelopeId={r.envelope.id} currency={currency} />
            </Card>
          ) : null}
        </div>
        {/* UX-002: the decision stays in view while the diff scrolls; on a phone it comes first. */}
        <div className="order-first flex flex-col gap-5 lg:order-none">
          <div className="z-10 lg:sticky lg:top-24" data-testid="decision-sticky">
            <DecisionBar r={r} comment={comment} setComment={setComment} pending={decide.isPending} error={decide.error?.message ?? null} onDecide={(d) => decide.mutate(d)} />
          </div>
          <Card title={t("approvals.chain")}>
            <Chain r={r} />
          </Card>
          <Card title={t("tags.title")}>
            <TagChips ws={ws} entity={{ type: "approval_request", id: r.id }} />
          </Card>
          <Card title={t("approvals.timeline")}>
            <DecisionTimeline r={r} />
          </Card>
        </div>
      </div>
    </Page>
  );
}

