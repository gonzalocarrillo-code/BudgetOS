import type { HomeResponse } from "@budget/domain";
import { t, type MessageKey } from "@budget/ui/i18n";
import { Link } from "@tanstack/react-router";
import { ChartColumn, CircleCheck, FlaskConical, NotebookPen, Send, Target } from "lucide-react";
import type { ReactElement } from "react";
import { Card } from "../../components/page.js";
import { relativeTime } from "./time.js";
import { verb } from "./waiting.js";

/**
 * Pick up where you left off, and Sent by you (HO-006): the last things the person worked on, each
 * with where it sits and what they did; their saved views as chips; their requests still waiting,
 * and on whom.
 */
const ICON = { envelope: ChartColumn, approval_request: CircleCheck, experiment: FlaskConical, manual_entry: NotebookPen, target: Target } as const;

function RecentLink({ ws, r, children }: { ws: string; r: HomeResponse["recents"][number]; children: ReactElement }): ReactElement {
  const cls = "flex min-w-0 flex-1 items-center gap-2 rounded-md py-2 hover:text-primary";
  switch (r.entityType) {
    case "envelope":
      return <Link to="/w/$ws/budgets" params={{ ws }} search={{ select: r.entityId } as never} className={cls}>{children}</Link>;
    case "approval_request":
      return <Link to="/w/$ws/approvals/$id" params={{ ws, id: r.entityId }} className={cls}>{children}</Link>;
    case "experiment":
      return <Link to="/w/$ws/experiments/$id" params={{ ws, id: r.entityId }} className={cls}>{children}</Link>;
    case "manual_entry":
      return <Link to="/w/$ws/sources/manual" params={{ ws }} search={{ batch: r.entityId } as never} className={cls}>{children}</Link>;
    default:
      return <Link to="/w/$ws/targets" params={{ ws }} search={{ select: r.entityId } as never} className={cls}>{children}</Link>;
  }
}

export function Recents({ ws, home }: { ws: string; home: HomeResponse }): ReactElement {
  return (
    <Card title={t("home.recents.title")} tour="home-recents">
      {home.recents.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">{t("home.recentsEmpty")}</p>
      ) : (
        <ul className="-my-1 flex flex-col divide-y divide-border text-sm" data-testid="home-recents">
          {home.recents.map((r) => {
            const Icon = ICON[r.entityType as keyof typeof ICON] ?? ChartColumn;
            return (
              <li key={`${r.entityType}-${r.entityId}`} className="flex items-center gap-3" data-testid="home-recent">
                <RecentLink ws={ws} r={r}>
                  <>
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium" title={r.title}>
                        {r.title}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">{[t(`home.entity.${r.entityType}` as MessageKey), r.parent, verb(r.action)].filter(Boolean).join(" · ")}</span>
                    </span>
                  </>
                </RecentLink>
                <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(r.at)}</span>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground" data-testid="home-views">
        {home.pinnedViews.length === 0 ? (
          <span>{t("home.viewsEmpty")}</span>
        ) : (
          <>
            <span>{t("home.views.label")}</span>
            {home.pinnedViews.map((v) => (
              <Link key={v.id} to="/w/$ws/budgets" params={{ ws }} search={{ ...v.definition, savedViewId: v.id } as never} className="rounded-full border border-border bg-card px-2.5 py-1 font-medium text-foreground hover:bg-accent" data-testid="home-view">
                {v.name}
              </Link>
            ))}
          </>
        )}
      </div>
    </Card>
  );
}

export function Sent({ ws, home }: { ws: string; home: HomeResponse }): ReactElement {
  const sent = home.sent ?? [];
  const now = Date.now();
  return (
    <Card title={t("home.sent.title", { count: sent.length })} tour="home-sent" testId="home-sent">
      {sent.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">{t("home.sent.empty")}</p>
      ) : (
        <ul className="-my-1 flex flex-col divide-y divide-border text-sm">
          {sent.map((s) => {
            const overdue = s.dueAt !== null && new Date(s.dueAt).getTime() < now;
            return (
              <li key={s.id} data-testid="home-sent-item">
                <Link to="/w/$ws/approvals/$id" params={{ ws, id: s.id }} className="flex items-center gap-3 py-2 hover:text-primary">
                  <Send className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium" title={s.title}>
                      {s.title}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">{s.waitingOn ? t("home.sent.waitingOn", { role: t(`role.${s.waitingOn.toLowerCase()}` as MessageKey) }) : ""}</span>
                  </span>
                  <span className={overdue ? "shrink-0 text-xs font-medium text-danger-text" : "shrink-0 text-xs text-muted-foreground"}>{relativeTime(s.requestedAt)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-2">
        <Link to="/w/$ws/approvals" params={{ ws }} search={{ tab: "open" } as never} className="text-sm font-medium text-primary hover:underline">
          {t("home.sent.all")}
        </Link>
      </div>
    </Card>
  );
}
