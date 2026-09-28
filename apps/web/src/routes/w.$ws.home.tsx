import { HomeResponse } from "@budget/domain";
import { formatMoney } from "@budget/grid";
import { cn } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { AtSign, Bell, CircleCheck, Clock, Database, Eye, Sparkles } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { z } from "zod";
import { Card, Page } from "../components/page.js";
import { api, unwrap } from "../lib/api.js";
import { meQuery } from "../lib/queries.js";

/**
 * Home (spec §27, plan §11.7 "a to-do list, not a feed"): what is waiting on you first — approvals
 * you can decide, mentions, alerts assigned to you, unmatched spend — then a pacing strip per
 * top-level budget you own or your roles cover (% of the budget spent this fiscal year), then what
 * you touched last and saved views. Every block opens its screen filtered; empty states say what next.
 */
export const Route = createFileRoute("/w/$ws/home")({ component: HomePage });

const CURRENCY = "USD";
const homeQuery = (ws: string) => ({ queryKey: ["home", ws], queryFn: async () => HomeResponse.parse(await unwrap(api.GET("/api/v1/me/home", { params: { header: { "X-Workspace-Id": ws } } }))) });
const pct = (v: string | null) => (v === null ? "—" : `${Math.round(Number(v) * 100)}%`);

function HomePage(): ReactElement {
  const { ws } = Route.useParams();
  const { data: me } = useQuery(meQuery);
  const { data: home, isPending, error } = useQuery(homeQuery(ws));
  const { data: demo } = useQuery({ queryKey: ["demo-data", ws], queryFn: async () => z.object({ envelopes: z.number() }).parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/demo-data", { params: { path: { ws } } }))) });
  const first = (me?.user.name ?? "").split(" ").at(-1) ?? "";

  return (
    <Page title={t("home.title", { name: first })}>
      {demo && demo.envelopes > 0 ? (
        <div role="status" className="flex items-center gap-3 rounded-lg border border-primary/30 bg-secondary px-4 py-2.5 text-sm" data-testid="home-demo">
          <Sparkles className="size-4 text-primary" aria-hidden />
          <span className="flex-1">{t("home.demo", { count: demo.envelopes })}</span>
          <Link to="/w/$ws/admin/templates" params={{ ws }} className="font-medium text-primary hover:underline">
            {t("home.demoManage")}
          </Link>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error.message}</p> : null}
      {isPending || !home ? <p className="text-sm text-muted-foreground">{t("shell.loading")}</p> : <HomeBlocks ws={ws} home={home} />}
    </Page>
  );
}

function HomeBlocks({ ws, home }: { ws: string; home: HomeResponse }): ReactElement {
  const w = home.waitingOnMe;
  const total = w.approvals.length + w.mentions.length + w.alerts.length + (w.unmatched > 0 ? 1 : 0);
  return (
    <div className="flex flex-col gap-5">
      <Card title={t("home.waiting", { count: total })} tour="home-waiting">
        {total === 0 ? (
          <p className="flex items-center gap-2 py-2 text-sm text-muted-foreground" data-testid="home-waiting-empty">
            <CircleCheck className="size-4 text-success" aria-hidden /> {t("home.waitingEmpty")}
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border" data-testid="home-waiting">
            {w.approvals.map((a) => (
              <Item key={a.id} icon={<CircleCheck className="size-4 text-primary" aria-hidden />} kind={t("home.kind.approval")} testId="home-approval">
                <Link to="/w/$ws/approvals/$id" params={{ ws, id: a.id }} className="font-medium hover:text-primary">
                  {a.summary ?? t("page.approval")}
                </Link>
                {a.dueAt ? <span className="ml-2 text-xs text-muted-foreground">{t("home.due", { date: a.dueAt.slice(0, 10) })}</span> : null}
              </Item>
            ))}
            {w.mentions.map((m) => (
              <Item key={m.commentId} icon={<AtSign className="size-4 text-warning" aria-hidden />} kind={t("home.kind.mention", { name: m.author ?? "—" })} testId="home-mention">
                {m.anchorType === "envelope" || m.anchorType === "cell" ? (
                  <Link to="/w/$ws/budgets" params={{ ws }} search={{ select: m.anchorId } as never} className="line-clamp-1 hover:text-primary">
                    {m.body.replace(/@\[(user|group):[^\]]+\]/g, "@…")}
                  </Link>
                ) : m.anchorType === "approval_request" ? (
                  <Link to="/w/$ws/approvals/$id" params={{ ws, id: m.anchorId }} className="line-clamp-1 hover:text-primary">
                    {m.body.replace(/@\[(user|group):[^\]]+\]/g, "@…")}
                  </Link>
                ) : (
                  <span className="line-clamp-1">{m.body.replace(/@\[(user|group):[^\]]+\]/g, "@…")}</span>
                )}
              </Item>
            ))}
            {w.alerts.map((a) => (
              <Item key={a.id} icon={<Bell className="size-4 text-destructive" aria-hidden />} kind={t("home.kind.alert", { severity: a.severity })} testId="home-alert">
                <Link to="/w/$ws/alerts" params={{ ws }} search={{ select: a.id } as never} className="font-medium hover:text-primary">
                  {a.envelopeName}
                </Link>
              </Item>
            ))}
            {w.unmatched > 0 ? (
              <Item icon={<Database className="size-4 text-muted-foreground" aria-hidden />} kind={t("home.kind.unmatched")} testId="home-unmatched">
                <Link to="/w/$ws/sources" params={{ ws }} className="font-medium hover:text-primary">
                  {t("home.unmatched", { count: w.unmatched })}
                </Link>
              </Item>
            ) : null}
          </ul>
        )}
      </Card>

      <Card title={t("home.pacing")} tour="home-pacing">
        {home.scopes.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">{t("home.pacingEmpty")}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="home-scopes">
            {home.scopes.map((s) => {
              const spent = s.spentPct === null ? 0 : Math.min(1.2, Number(s.spentPct));
              const pace = s.paceIndex === null ? null : Number(s.paceIndex);
              const tone = pace === null ? "bg-subtle-foreground" : pace > 1.1 ? "bg-warning" : pace < 0.9 ? "bg-primary" : "bg-success";
              return (
                <Link key={s.label} to="/w/$ws/budgets" params={{ ws }} search={{ filter: s.filter, period: { kind: "relative", preset: "current_year" } } as never} className="flex flex-col gap-2 rounded-xl border border-border p-4 hover:border-primary/50 hover:bg-accent/40" data-testid="home-scope">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-semibold">{s.label}</span>
                    <span className="text-sm font-semibold tabular-nums" data-testid="home-scope-spent">
                      {pct(s.spentPct)}
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
                    <div className={cn("h-full rounded-full", tone)} style={{ width: `${Math.round((spent / 1.2) * 100)}%` }} />
                  </div>
                  <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
                    <span>{t("home.spentOf", { actual: s.actual ? formatMoney(s.actual, CURRENCY) : "—", budget: s.budget ? formatMoney(s.budget, CURRENCY) : "—" })}</span>
                    <span>{s.projected && Number(s.projected) > 0 ? t("home.projected", { amount: formatMoney(s.projected, CURRENCY) }) : ""}</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title={t("home.recents")}>
          {home.recents.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">{t("home.recentsEmpty")}</p>
          ) : (
            <ul className="flex flex-col gap-1" data-testid="home-recents">
              {home.recents.map((r) => (
                <li key={`${r.entityType}-${r.entityId}`} className="flex items-center gap-2 text-sm">
                  <Clock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <RecentLink ws={ws} r={r} />
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">{t(`home.entity.${r.entityType}` as MessageKey)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={t("home.views")}>
          {home.pinnedViews.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">{t("home.viewsEmpty")}</p>
          ) : (
            <ul className="flex flex-col gap-1" data-testid="home-views">
              {home.pinnedViews.map((v) => (
                <li key={v.id}>
                  <Link to="/w/$ws/budgets" params={{ ws }} search={{ ...v.definition, savedViewId: v.id } as never} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-accent">
                    <Eye className="size-3.5 text-muted-foreground" aria-hidden /> {v.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function Item({ icon, kind, children, testId }: { icon: ReactNode; kind: string; children: ReactNode; testId: string }): ReactElement {
  return (
    <li className="flex items-start gap-3 py-2.5 text-sm" data-testid={testId}>
      <span className="mt-0.5">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">{kind}</p>
        {children}
      </div>
    </li>
  );
}

function RecentLink({ ws, r }: { ws: string; r: HomeResponse["recents"][number] }): ReactElement {
  const cls = "min-w-0 truncate hover:text-primary";
  switch (r.entityType) {
    case "envelope":
      return <Link to="/w/$ws/budgets" params={{ ws }} search={{ select: r.entityId } as never} className={cls}>{r.title}</Link>;
    case "approval_request":
      return <Link to="/w/$ws/approvals/$id" params={{ ws, id: r.entityId }} className={cls}>{r.title}</Link>;
    case "experiment":
      return <Link to="/w/$ws/experiments/$id" params={{ ws, id: r.entityId }} className={cls}>{r.title}</Link>;
    case "manual_entry":
      return <Link to="/w/$ws/sources/manual" params={{ ws }} search={{ batch: r.entityId } as never} className={cls}>{r.title}</Link>;
    default:
      return <Link to="/w/$ws/targets" params={{ ws }} search={{ select: r.entityId } as never} className={cls}>{r.title}</Link>;
  }
}
