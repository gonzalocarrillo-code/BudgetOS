import { formatMoney } from "@budget/grid";
import { Button } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { timelinePage, type TimelineEntry } from "../../lib/queries.js";

/**
 * A budget's edit history (plan §8.6, 0.6): the Decision Timeline, newest first — versions with
 * before → after, submissions, every decision with its account and comment, alerts, closures,
 * loads. An ordered list: each entry reads (and is announced) as who, what, when, and how much.
 */

const amountOf = (v: unknown): string | null => {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const a = o["amount"] ?? o["approvedAmount"] ?? o["total"];
  return typeof a === "string" || typeof a === "number" ? String(a) : null;
};
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function Entry({ e, currency }: { e: TimelineEntry; currency: string }): ReactElement {
  const who = e.actor?.name ?? (e.actor?.type === "system" ? t("drawer.history.system") : null) ?? t("drawer.history.system");
  const before = amountOf(e.detail.before);
  const after = amountOf(e.detail.after);
  const text = e.detail.reason ?? e.detail.body;
  return (
    <li className="relative border-l border-border pb-4 pl-4 last:pb-0" data-testid="history-entry">
      <span className="absolute -left-[5px] top-1.5 size-2.5 rounded-full border-2 border-card bg-primary" aria-hidden />
      <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-medium" data-testid="history-title">
          {e.title}
        </span>
        <span className="text-muted-foreground" data-testid="history-actor">
          {who}
        </span>
      </div>
      <time className="block text-xs text-muted-foreground" dateTime={e.at}>
        {when(e.at)}
      </time>
      {before !== null || after !== null ? (
        <p className="tabular mt-1 text-sm" data-testid="history-amounts">
          {before !== null ? <span className="text-muted-foreground line-through decoration-muted-foreground/60">{formatMoney(before, currency)}</span> : null}
          {before !== null && after !== null ? <span aria-hidden> → </span> : null}
          {before !== null && after !== null ? <span className="sr-only"> to </span> : null}
          {after !== null ? <span className="font-medium">{formatMoney(after, currency)}</span> : null}
        </p>
      ) : null}
      {text ? <p className="mt-1 whitespace-pre-line rounded-md bg-surface px-2 py-1 text-sm text-foreground/90">{text}</p> : null}
    </li>
  );
}

export function HistoryList({ ws, envelopeId, currency }: { ws: string; envelopeId: string; currency: string }): ReactElement {
  const q = useInfiniteQuery({
    queryKey: ["timeline", ws, envelopeId],
    queryFn: ({ pageParam }) => timelinePage(ws, envelopeId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const rows = q.data?.pages.flatMap((p) => p.rows) ?? [];
  if (q.isPending) return <p className="text-sm text-muted-foreground">{t("shell.loading")}</p>;
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{t("drawer.history.empty")}</p>;
  return (
    <div className="flex flex-col gap-3">
      <ol className="ml-1" aria-label={t("drawer.tab.history")} data-testid="history-list">
        {rows.map((e) => (
          <Entry key={`${e.source}-${e.id}`} e={e} currency={currency} />
        ))}
      </ol>
      {q.hasNextPage ? (
        <Button variant="outline" size="sm" onClick={() => void q.fetchNextPage()}>
          {t("drawer.history.more")}
        </Button>
      ) : null}
    </div>
  );
}
