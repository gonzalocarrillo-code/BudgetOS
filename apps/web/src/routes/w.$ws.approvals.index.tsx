import { cn, Avatar, SkeletonRows, TBody, TD, TH, THead, TR, Table } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { z } from "zod";
import { Card, Page } from "../components/page.js";
import { StatusChip, stepLabel } from "../features/approvals/parts.js";
import { approvalsQuery } from "../lib/queries.js";

/** Approvals inbox (spec §18.5): what waits for me, everything open, what is resolved. */
export const Route = createFileRoute("/w/$ws/approvals/")({ validateSearch: z.object({ tab: z.enum(["mine", "open", "resolved"]).default("mine") }), component: Inbox });

const TABS = [
  { id: "mine", label: "approvals.tab.mine" },
  { id: "open", label: "approvals.tab.open" },
  { id: "resolved", label: "approvals.tab.resolved" },
] as const;

function Inbox(): ReactElement {
  const { ws } = Route.useParams();
  const { tab } = Route.useSearch();
  const { data, isPending } = useQuery(approvalsQuery(ws, tab));
  const rows = data?.rows ?? [];
  return (
    <Page title={t("nav.approvals")}>
      <div role="tablist" className="inline-flex w-fit rounded-lg border border-border bg-card p-0.5" data-testid="approvals-tabs" data-tour="approvals-tabs">
        {TABS.map((x) => (
          <Link key={x.id} to="/w/$ws/approvals" params={{ ws }} search={{ tab: x.id }} role="tab" aria-selected={tab === x.id} className={cn("h-8 rounded-md px-3 text-sm leading-8", tab === x.id ? "bg-primary text-primary-foreground" : "text-foreground/80 hover:bg-accent")} data-testid={`approvals-tab-${x.id}`}>
            {t(x.label)}
          </Link>
        ))}
      </div>
      <Card tour="approvals-list">
        {isPending ? (
          <SkeletonRows rows={4} />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="approvals-empty">
            {t(tab === "mine" ? "approvals.empty.mine" : "approvals.empty")}
          </p>
        ) : (
          <Table data-testid="approvals-table">
            <THead>
              <tr>
                <TH>{t("approvals.col.request")}</TH>
                <TH className="hidden md:table-cell">{t("approvals.col.requestedBy")}</TH>
                <TH className="hidden md:table-cell">{t("approvals.col.step")}</TH>
                <TH>{t("approvals.col.due")}</TH>
                <TH>{t("approvals.col.status")}</TH>
              </tr>
            </THead>
            <TBody>
              {rows.map((r) => {
                // DS-004: what is late reads as late, not only as a date.
                const overdue = r.dueAt !== null && r.dueAt !== undefined && new Date(r.dueAt).getTime() < Date.now() && (r.status === "PENDING" || r.status === "ESCALATED");
                return (
                  <TR key={r.id} data-testid="approval-row">
                    <TD>
                      <Link to="/w/$ws/approvals/$id" params={{ ws, id: r.id }} className="font-medium text-foreground hover:text-primary" data-testid="approval-link">
                        {r.summary ?? r.entityType}
                      </Link>
                      <div className="text-xs text-muted-foreground">{t("approvals.rows", { count: r.rows })}</div>
                    </TD>
                    <TD className="hidden md:table-cell">
                      {r.requestedByName ? (
                        <span className="flex items-center gap-2">
                          <Avatar name={r.requestedByName} size={24} />
                          {r.requestedByName}
                        </span>
                      ) : (
                        "—"
                      )}
                    </TD>
                    <TD className="hidden md:table-cell">{t("approvals.stepOf", { n: stepLabel(r.currentStep) })}</TD>
                    <TD numeric className={cn("text-left", overdue && "font-medium text-danger-text")}>
                      {r.dueAt ? new Date(r.dueAt).toLocaleDateString() : "—"}
                      {overdue ? <span className="ml-1 text-xs">· {t("approvals.overdue")}</span> : null}
                    </TD>
                    <TD>
                      <StatusChip status={r.status} />
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>
    </Page>
  );
}
