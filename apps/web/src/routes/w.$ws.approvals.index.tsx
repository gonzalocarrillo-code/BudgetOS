import { cn } from "@budget/ui";
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
      <div role="tablist" className="inline-flex w-fit rounded-lg border border-border bg-card p-0.5" data-testid="approvals-tabs">
        {TABS.map((x) => (
          <Link key={x.id} to="/w/$ws/approvals" params={{ ws }} search={{ tab: x.id }} role="tab" aria-selected={tab === x.id} className={cn("h-8 rounded-md px-3 text-sm leading-8", tab === x.id ? "bg-primary text-primary-foreground" : "text-foreground/80 hover:bg-accent")} data-testid={`approvals-tab-${x.id}`}>
            {t(x.label)}
          </Link>
        ))}
      </div>
      <Card>
        {isPending ? (
          <p className="text-sm text-muted-foreground">{t("shell.loading")}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="approvals-empty">
            {t(tab === "mine" ? "approvals.empty.mine" : "approvals.empty")}
          </p>
        ) : (
          <table className="w-full text-sm" data-testid="approvals-table">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-2 pr-3 font-medium">{t("approvals.col.request")}</th>
                <th className="py-2 pr-3 font-medium">{t("approvals.col.requestedBy")}</th>
                <th className="py-2 pr-3 font-medium">{t("approvals.col.step")}</th>
                <th className="py-2 pr-3 font-medium">{t("approvals.col.due")}</th>
                <th className="py-2 font-medium">{t("approvals.col.status")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border" data-testid="approval-row">
                  <td className="py-2.5 pr-3">
                    <Link to="/w/$ws/approvals/$id" params={{ ws, id: r.id }} className="font-medium text-foreground hover:text-primary" data-testid="approval-link">
                      {r.summary ?? r.entityType}
                    </Link>
                    <div className="text-xs text-muted-foreground">{t("approvals.rows", { count: r.rows })}</div>
                  </td>
                  <td className="py-2.5 pr-3">{r.requestedByName ?? "—"}</td>
                  <td className="py-2.5 pr-3">{stepLabel(r.currentStep)}</td>
                  <td className="py-2.5 pr-3 tabular">{r.dueAt ? new Date(r.dueAt).toLocaleDateString() : "—"}</td>
                  <td className="py-2.5">
                    <StatusChip status={r.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </Page>
  );
}
