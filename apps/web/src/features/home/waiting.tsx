import type { HomeResponse } from "@budget/domain";
import { formatMoney, formatPctChange } from "@budget/grid";
import { Chip, cn } from "@budget/ui";
import { hasMessage, t, type MessageKey } from "@budget/ui/i18n";
import { Link } from "@tanstack/react-router";
import { AtSign, BellRing, CircleCheck, Database, Lock, PencilLine, TriangleAlert } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Card } from "../../components/page.js";
import { dayMonth, relativeTime } from "./time.js";

/**
 * "Waiting on you" (HO-006, docs/HOME_OVERVIEW_PLAN.md §3.1): what the person can act on, most urgent
 * first — overdue approvals, then what is due, the quarter about to close, their unsent drafts, the
 * alerts on their budgets, mentions, then data to map. Each item: its kind, what it is, one line of
 * context and one action. At most ten; each action opens its screen filtered.
 */
type W = HomeResponse["waitingOnMe"];
interface Item {
  key: string;
  rank: number;
  node: ReactElement;
}
const MAX_ITEMS = 10;
const DAY = 86_400_000;
const SEVERITY_TONE: Record<string, "danger" | "warning" | "info" | "neutral"> = { critical: "danger", warning: "warning", info: "info", data: "neutral" };

export function Waiting({ ws, home, onDecide }: { ws: string; home: HomeResponse; onDecide?: (id: string) => void }): ReactElement {
  const w = home.waitingOnMe;
  const currency = home.workspace?.currency ?? "USD";
  const items = [...approvals(ws, w, currency, onDecide), ...closures(ws, w), ...drafts(ws, w), ...alertGroups(ws, w), ...mentions(ws, w), ...data(ws, w)].sort((a, b) => a.rank - b.rank).slice(0, MAX_ITEMS);
  return (
    <Card title={t("home.waiting", { count: items.length })} tour="home-waiting" testId="home-waiting-card">
      {items.length === 0 ? (
        <p className="flex items-center gap-2 py-2 text-sm text-muted-foreground" data-testid="home-waiting-empty">
          <CircleCheck className="size-4 text-success" aria-hidden /> {t("home.waitingEmpty")}
        </p>
      ) : (
        <ul className="-my-1 flex flex-col divide-y divide-border" data-testid="home-waiting">
          {items.map((i) => (
            <li key={i.key}>{i.node}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Row({ icon, tone, kind, title, context, action, testId }: { icon: ReactNode; tone: string; kind: string; title: ReactNode; context?: ReactNode; action: ReactNode; testId: string }): ReactElement {
  return (
    <div className="flex items-center gap-3 py-3" data-testid={testId}>
      <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", tone)} aria-hidden>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium uppercase tracking-[0.04em] text-muted-foreground">{kind}</p>
        <div className="text-sm font-medium">{title}</div>
        {context ? <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">{context}</div> : null}
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}

const actionClass = "inline-flex h-8 items-center rounded-lg border border-border bg-card px-3 text-sm font-medium hover:bg-accent";
const primaryClass = "inline-flex h-8 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90";

function approvals(ws: string, w: W, currency: string, onDecide?: (id: string) => void): Item[] {
  const now = Date.now();
  return w.approvals.map((a) => {
    const due = a.dueAt ? new Date(a.dueAt).getTime() : null;
    const overdue = due !== null && due < now;
    const soon = due !== null && !overdue && due - now < 2 * DAY;
    const change =
      a.after && a.before
        ? (a.count ?? 1) > 1
          ? t("home.approval.change", { count: a.count ?? 1, before: formatMoney(a.before, currency), after: formatMoney(a.after, currency), pct: a.changePct ? formatPctChange(a.changePct) : "—" })
          : t("home.approval.changeOne", { before: formatMoney(a.before, currency), after: formatMoney(a.after, currency), pct: a.changePct ? formatPctChange(a.changePct) : "—" })
        : a.after
          ? t("home.approval.new", { after: formatMoney(a.after, currency) })
          : null;
    const decide = onDecide ? (
      <button type="button" className={primaryClass} onClick={() => onDecide(a.id)} data-testid="home-decide">
        {t("home.action.decide")}
      </button>
    ) : (
      <Link to="/w/$ws/approvals/$id" params={{ ws, id: a.id }} className={primaryClass} data-testid="home-decide">
        {t("home.action.decide")}
      </Link>
    );
    return {
      key: `a-${a.id}`,
      rank: overdue ? 0 : soon ? 1 : 3,
      node: (
        <Row
          icon={<CircleCheck className="size-4" />}
          tone="bg-secondary text-primary"
          kind={t("home.kind.approve")}
          title={<span data-testid="home-approval-title">{a.title ?? a.summary ?? t("page.approval")}</span>}
          context={
            <>
              {change ? <span className="tabular">{change}</span> : null}
              {a.requestedByName ? <span>{t("home.approval.by", { name: a.requestedByName })}</span> : null}
              {a.dueAt ? (
                <Chip tone={overdue ? "danger" : soon ? "warning" : "neutral"}>{overdue ? t("home.approval.overdue", { date: dayMonth(a.dueAt) }) : new Date(a.dueAt).toDateString() === new Date().toDateString() ? t("home.approval.dueToday") : t("home.approval.dueOn", { date: dayMonth(a.dueAt) })}</Chip>
              ) : null}
            </>
          }
          action={decide}
          testId="home-approval"
        />
      ),
    };
  });
}

function closures(ws: string, w: W): Item[] {
  return (w.closures ?? []).map((c) => {
    const period = c.periodKey;
    const title = c.daysLeft < 0 ? t("home.close.ended", { period, days: -c.daysLeft }) : c.daysLeft === 0 ? t("home.close.endsToday", { period }) : c.daysLeft === 1 ? t("home.close.endsTomorrow", { period }) : t("home.close.endsIn", { period, days: c.daysLeft });
    return {
      key: `c-${c.periodKey}`,
      rank: 2,
      node: (
        <Row
          icon={<Lock className="size-4" />}
          tone="bg-success-soft text-success-text"
          kind={t("home.kind.close")}
          title={title}
          context={<span>{c.drafts + c.pending > 0 ? t("home.close.body", { drafts: c.drafts, pending: c.pending }) : t("home.close.settled")}</span>}
          action={
            <Link to="/w/$ws/closures" params={{ ws }} className={actionClass}>
              {t("home.action.closures")}
            </Link>
          }
          testId="home-closure"
        />
      ),
    };
  });
}

function drafts(ws: string, w: W): Item[] {
  const d = w.drafts;
  const first = d?.items[0];
  if (!d || d.count === 0 || !first) return [];
  return [
    {
      key: "drafts",
      rank: 4,
      node: (
        <Row
          icon={<PencilLine className="size-4" />}
          tone="bg-neutral-soft text-neutral-text"
          kind={t("home.kind.send")}
          title={d.count === 1 ? t("home.drafts.one") : t("home.drafts.many", { count: d.count })}
          context={
            <span>
              {d.items.map((x, i) => (
                <span key={x.versionId}>
                  {i > 0 ? " · " : ""}
                  <Link to="/w/$ws/budgets" params={{ ws }} search={{ select: x.envelopeId } as never} className="hover:text-primary hover:underline">
                    {x.name}
                  </Link>
                </span>
              ))}
              {` · ${relativeTime(first.createdAt)}`}
            </span>
          }
          action={
            <Link to="/w/$ws/budgets" params={{ ws }} search={{ select: first.envelopeId } as never} className={actionClass} data-testid="home-drafts-review">
              {t("home.action.review")}
            </Link>
          }
          testId="home-drafts"
        />
      ),
    },
  ];
}

function alertGroups(ws: string, w: W): Item[] {
  return (w.alertsOnMyBudgets ?? []).map((g) => ({
    key: `g-${g.envelopeId}`,
    rank: g.assigned > 0 || g.severity === "critical" ? 5 : 7,
    node: (
      <Row
        icon={<BellRing className="size-4" />}
        tone="bg-danger-soft text-danger-text"
        kind={t("home.kind.alerts")}
        title={g.count === 1 ? t("home.alertGroup.one", { name: g.name }) : t("home.alertGroup.title", { count: g.count, name: g.name })}
        context={
          <>
            {g.assigned > 0 ? <span className="font-medium text-foreground">{t("home.alertGroup.assigned", { count: g.assigned })}</span> : null}
            {g.rules.map((r) => (
              <Link key={r.ruleId} to="/w/$ws/alerts" params={{ ws }} search={{ status: "OPEN", under: g.envelopeId, rule: r.ruleId } as never} className="rounded-full focus-visible:ring-2 focus-visible:ring-ring" data-testid="home-alert-rule">
                <Chip tone={SEVERITY_TONE[r.severity] ?? "neutral"}>{t("home.alertGroup.rule", { rule: r.ruleName ?? "—", count: r.count })}</Chip>
              </Link>
            ))}
          </>
        }
        action={
          <Link to="/w/$ws/alerts" params={{ ws }} search={{ status: "OPEN", under: g.envelopeId } as never} className={actionClass} data-testid="home-alert-open">
            {t("home.action.open")}
          </Link>
        }
        testId="home-alert-group"
      />
    ),
  }));
}

const mentionText = (body: string) => body.replace(/@\[(user|group):[^\]]+\]/g, "@…");

function mentions(ws: string, w: W): Item[] {
  return w.mentions.map((m) => {
    const to =
      m.anchorType === "envelope" || m.anchorType === "cell" ? (
        <Link to="/w/$ws/budgets" params={{ ws }} search={{ select: m.anchorId } as never} className={actionClass}>
          {t("home.action.reply")}
        </Link>
      ) : m.anchorType === "approval_request" ? (
        <Link to="/w/$ws/approvals/$id" params={{ ws, id: m.anchorId }} className={actionClass}>
          {t("home.action.reply")}
        </Link>
      ) : (
        <span />
      );
    return {
      key: `m-${m.commentId}`,
      rank: 6,
      node: (
        <Row
          icon={<AtSign className="size-4" />}
          tone="bg-warning-soft text-warning-text"
          kind={t("home.kind.mention", { name: m.author ?? "—" })}
          title={<span className="line-clamp-1 font-normal">“{mentionText(m.body)}”</span>}
          context={<span>{relativeTime(m.createdAt)}</span>}
          action={to}
          testId="home-mention"
        />
      ),
    };
  });
}

function data(ws: string, w: W): Item[] {
  const out: Item[] = [];
  for (const f of w.failedRuns ?? []) {
    out.push({
      key: `f-${f.sourceId}`,
      rank: 8,
      node: (
        <Row
          icon={<TriangleAlert className="size-4" />}
          tone="bg-danger-soft text-danger-text"
          kind={t("home.kind.data")}
          title={t("home.failed.title", { name: f.sourceName })}
          context={<span className="line-clamp-1">{[relativeTime(f.at), f.error].filter(Boolean).join(" · ")}</span>}
          action={
            <Link to="/w/$ws/sources" params={{ ws }} className={actionClass}>
              {t("home.action.open")}
            </Link>
          }
          testId="home-failed-run"
        />
      ),
    });
  }
  if (w.unmatched > 0) {
    out.push({
      key: "unmatched",
      rank: 9,
      node: (
        <Row
          icon={<Database className="size-4" />}
          tone="bg-neutral-soft text-neutral-text"
          kind={t("home.kind.unmatched")}
          title={t("home.unmatched", { count: w.unmatched })}
          action={
            <Link to="/w/$ws/sources" params={{ ws }} className={actionClass}>
              {t("home.action.map")}
            </Link>
          }
          testId="home-unmatched"
        />
      ),
    });
  }
  return out;
}

/** The words for what someone did, from the audit action ("you changed the amount"). */
export function verb(action: string | undefined): string {
  const key = `home.verb.${action ?? ""}`;
  return hasMessage(key) ? t(key as MessageKey) : t("home.verb.default");
}
