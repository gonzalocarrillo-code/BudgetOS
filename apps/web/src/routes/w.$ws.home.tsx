import { HomeResponse } from "@budget/domain";
import { AsOfChip, cn, Skeleton, SkeletonRows } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Bell, CircleCheck, Database, Plus, Sparkles, Users, Wallet } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { z } from "zod";
import { Card, Page } from "../components/page.js";
import { Desk } from "../features/home/desk.js";
import { TourInvite } from "../features/home/tour-launcher.js";
import { api, unwrap } from "../lib/api.js";
import { meQuery } from "../lib/queries.js";

/**
 * Home (spec §27, plan §11.7 "a to-do list, not a feed", docs/HOME_OVERVIEW_PLAN.md §3.1): the
 * person's desk. The workspace's pulse in one line, then what waits on them, their budgets, where
 * they left off and what they sent (features/home/desk.tsx). A blank workspace gets its first
 * steps instead. Every block opens its screen filtered; empty states say what next.
 */
export const Route = createFileRoute("/w/$ws/home")({ component: HomePage });

const homeQuery = (ws: string) => ({ queryKey: ["home", ws], queryFn: async () => HomeResponse.parse(await unwrap(api.GET("/api/v1/me/home", { params: { header: { "X-Workspace-Id": ws } } }))) });
const pct = (v: string | null) => (v === null ? "—" : `${Math.round(Number(v) * 100)}%`);

/** The person's first name for the greeting: the first word of their name, else their email's. */
export function firstName(name: string | undefined, email: string | undefined): string {
  const n = (name ?? "").trim();
  if (n) return n.split(/\s+/)[0] as string;
  const local = (email ?? "").split("@")[0] ?? "";
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : "";
}

const greetingKey = (hour: number): MessageKey => (hour < 12 ? "home.greeting.morning" : hour < 18 ? "home.greeting.afternoon" : "home.greeting.evening");

function HomePage(): ReactElement {
  const { ws } = Route.useParams();
  const { data: me } = useQuery(meQuery);
  const { data: home, isPending, error } = useQuery(homeQuery(ws));
  const { data: demo } = useQuery({ queryKey: ["demo-data", ws], queryFn: async () => z.object({ envelopes: z.number() }).parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/demo-data", { params: { path: { ws } } }))) });
  const name = firstName(me?.user.name, me?.user.email);
  const today = new Date();
  const dateLine = today.toLocaleDateString("en", { weekday: "long", day: "numeric", month: "long" });

  return (
    <Page title={name ? t(greetingKey(today.getHours()), { name }) : t("home.titleNoName")} stickyOnPhone={false} readable>
      <div className="-mt-3 flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted-foreground" data-testid="home-subtitle">
          {home?.workspace ? t("home.subtitle", { workspace: home.workspace.name, date: dateLine, elapsed: pct(home.workspace.period.elapsed) }) : dateLine}
        </p>
        {home?.asOf ? <AsOfChip through={home.asOf.through} stale={home.asOf.stale} staleDays={home.asOf.staleDays} grain={home.asOf.grain} testId="home-as-of" /> : null}
      </div>
      <TourInvite ws={ws} />
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
      {isPending || !home ? <HomeSkeleton /> : home.setup && home.setup.budgets === 0 ? <GettingStarted ws={ws} home={home} /> : <Desk ws={ws} home={home} />}
    </Page>
  );
}

/** Home while it loads (UX-007, HO-017): the desk's shape — the pulse line, then its cards. */
function HomeSkeleton(): ReactElement {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label={t("shell.loading")} data-testid="home-skeleton">
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-border bg-card px-4 py-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-2 w-32" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-28" />
      </div>
      <div className="rounded-xl border border-border bg-card p-5">
        <SkeletonRows rows={3} />
      </div>
      <div className="rounded-xl border border-border bg-card p-5">
        <SkeletonRows rows={3} />
      </div>
    </div>
  );
}

/** An empty workspace: the first budgets, then what makes them useful (product feedback 2026-09-28). */
function GettingStarted({ ws, home }: { ws: string; home: HomeResponse }): ReactElement {
  const setup = home.setup ?? { budgets: 0, sources: 0, people: 0, spend: false, tags: 0 };
  const steps: Array<{ key: string; title: MessageKey; body: MessageKey; done: boolean; to: string; search?: Record<string, unknown>; cta: MessageKey; icon: ReactNode }> = [
    { key: "budgets", title: "home.start.budgets", body: "home.start.budgetsBody", done: setup.budgets > 0, to: "/w/$ws/budgets", search: { new: true }, cta: "home.start.budgetsCta", icon: <Wallet className="size-4" aria-hidden /> },
    { key: "data", title: "home.start.data", body: "home.start.dataBody", done: setup.sources > 0 || setup.spend, to: "/w/$ws/admin/sources", cta: "home.start.dataCta", icon: <Database className="size-4" aria-hidden /> },
    { key: "people", title: "home.start.people", body: "home.start.peopleBody", done: setup.people > 0, to: "/w/$ws/admin/roles", cta: "home.start.peopleCta", icon: <Users className="size-4" aria-hidden /> },
    { key: "approvals", title: "home.start.approvals", body: "home.start.approvalsBody", done: false, to: "/w/$ws/admin/policies", cta: "home.start.approvalsCta", icon: <CircleCheck className="size-4" aria-hidden /> },
    { key: "alerts", title: "home.start.alerts", body: "home.start.alertsBody", done: false, to: "/w/$ws/admin/rules", cta: "home.start.alertsCta", icon: <Bell className="size-4" aria-hidden /> },
  ];
  return (
    <div className="flex flex-col gap-5" data-testid="home-getting-started">
      <section className="flex flex-col gap-4 rounded-2xl border border-primary/25 bg-gradient-to-br from-secondary to-card p-6 sm:flex-row sm:items-center">
        <div className="grid size-12 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground">
          <Wallet className="size-6" aria-hidden />
        </div>
        <div className="flex-1">
          <h2 className="text-xl font-semibold tracking-[-0.02em]" data-testid="home-first-budgets">{t("home.start.title")}</h2>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">{t("home.start.body")}</p>
        </div>
        <Link to="/w/$ws/budgets" params={{ ws }} search={{ new: true } as never} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90" data-testid="home-new-budget">
          <Plus className="size-4" aria-hidden />
          {t("home.start.budgetsCta")}
        </Link>
      </section>
      <Card title={t("home.start.steps", { done: steps.filter((s) => s.done).length, total: steps.length })}>
        <ol className="flex flex-col divide-y divide-border" data-testid="home-steps">
          {steps.map((s, i) => (
            <li key={s.key} className="flex items-center gap-4 py-3" data-testid="home-step" data-done={s.done}>
              <span className={cn("grid size-8 shrink-0 place-items-center rounded-full border text-sm font-semibold", s.done ? "border-success bg-success/15 text-success" : "border-border text-muted-foreground")}>
                {s.done ? <CircleCheck className="size-4" aria-hidden /> : i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <span className="text-muted-foreground">{s.icon}</span>
                  {t(s.title)}
                </p>
                <p className="text-xs text-muted-foreground">{t(s.body)}</p>
              </div>
              <Link to={s.to as never} params={{ ws } as never} search={(s.search ?? {}) as never} className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent">
                {s.done ? t("home.start.open") : t(s.cta)}
              </Link>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
