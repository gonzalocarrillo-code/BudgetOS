import { TimelineResponse, type FilterGroupT, type PeriodSpec, type TimelineZoom } from "@budget/domain";
import { useExplorerLabels } from "../explorer/labels.js";
import { formatMoney } from "@budget/grid";
import { BudgetTimeline, type BudgetTimelineLabels } from "@budget/timeline";
import { t } from "@budget/ui/i18n";
import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query";
import { useMemo, type ReactElement } from "react";
import { api, unwrap } from "../../lib/api.js";
import { encodeFilter } from "../../lib/filters.js";

/**
 * The Explorer's Timeline view (spec §23.3, T-037): the same search params as the tree (filter,
 * hierarchy template, period, as-of) drawn by `@budget/timeline`. The server groups, totals and
 * places targets; this view only fetches pages and hands them over. Read-only (drag is epic 2.5).
 */

/** Envelope bars fetched per view: pages of 2,000 up to 5,000 (the 5k-bar budget, spec §23.2). */
const PAGE = 2000;
const MAX_ENVELOPES = 5000;

export interface TimelineSearch {
  filter: FilterGroupT;
  templateId?: string | undefined;
  /** Budget structure (ADR-050): nest by parent links, not a hierarchy template. */
  structure?: boolean | undefined;
  period: PeriodSpec;
  asOf?: string | undefined;
  zoom: TimelineZoom;
}

export const timelineQuery = (ws: string, s: TimelineSearch) =>
  queryOptions({
    queryKey: ["timeline", ws, s.filter, s.structure ? "structure" : (s.templateId ?? null), s.period, s.asOf ?? null, s.zoom],
    queryFn: async (): Promise<TimelineResponse & { truncated: boolean }> => {
      let cursor: string | null = null;
      let first = null as TimelineResponse | null;
      let envelopes = 0;
      do {
        const query = {
          period: s.period.kind === "relative" ? s.period.preset : JSON.stringify(s.period),
          zoom: s.zoom,
          limit: PAGE,
          ...(s.filter.children.length ? { filter: encodeFilter(s.filter) } : {}),
          ...(s.structure ? { structure: "true" } : s.templateId ? { templateId: s.templateId } : {}),
          ...(s.asOf ? { asOf: s.asOf } : {}),
          ...(cursor ? { cursor } : {}),
        };
        const page = TimelineResponse.parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/timeline", { params: { path: { ws }, query: query as never } })));
        envelopes += page.bars.filter((b) => b.kind === "envelope").length;
        first = first ? { ...first, bars: [...first.bars, ...page.bars], nextCursor: page.nextCursor } : page;
        cursor = page.nextCursor;
      } while (cursor && envelopes < MAX_ENVELOPES);
      if (first === null) throw new Error("timeline returned no page");
      return { ...first, truncated: cursor !== null };
    },
    placeholderData: keepPreviousData,
  });

export function TimelineView({
  ws,
  search,
  currency,
  onSelect,
  onAsOf,
}: {
  ws: string;
  search: TimelineSearch;
  currency: string;
  onSelect: (envelopeId: string) => void;
  onAsOf: (asOf: string | undefined) => void;
}): ReactElement {
  const today = new Date().toISOString().slice(0, 10);
  const { data, isPending, error, isFetching } = useQuery(timelineQuery(ws, search));
  const explorer = useExplorerLabels(ws);
  const levels = data?.levels;
  const labels: BudgetTimelineLabels = useMemo(
    () => ({
      // A group with no value: the account at the first level, "No <granularity>" deeper (feedback 2).
      noneAt: (level: number) => explorer.none(levels?.[level] ?? "", level),
      name: t("timeline.col.name"),
      budget: t("timeline.col.budget"),
      spent: t("timeline.col.spent"),
      today: t("timeline.today"),
      asOf: t("timeline.asOf"),
      inherited: t("timeline.inherited"),
      none: t("explorer.none"),
      marker: { approval: t("timeline.marker.approval"), alert: t("timeline.marker.alert"), closure: t("timeline.marker.closure"), comment: t("timeline.marker.comment"), version: t("timeline.marker.version") },
    }),
    [explorer, levels],
  );

  if (error) return <p role="alert" className="text-sm text-destructive">{t("explorer.error", { message: error.message })}</p>;
  if (isPending || !data) return <p className="text-sm text-muted-foreground">{t("timeline.loading")}</p>;
  const envelopes = data.bars.filter((b) => b.kind === "envelope").length;
  return (
    <div className="flex h-full min-h-0 flex-col gap-2" data-testid="timeline-view" data-envelopes={envelopes} data-as-of={data.asOf ?? ""} data-fetching={isFetching}>
      {data.truncated ? <p className="text-xs text-warning" data-testid="timeline-truncated">{t("timeline.truncated", { count: envelopes })}</p> : null}
      {envelopes === 0 ? (
        <p className="text-sm text-muted-foreground">{t("timeline.empty")}</p>
      ) : (
        <div className="min-h-0 flex-1">
          <BudgetTimeline
            data={data}
            zoom={search.zoom}
            asOf={search.asOf}
            today={today}
            labels={labels}
            formatMoney={(a) => formatMoney(a, currency)}
            onOpen={(o) => {
              if (o.bar.envelopeId) onSelect(o.bar.envelopeId);
            }}
            onAsOfChange={onAsOf}
          />
        </div>
      )}
      <Legend />
    </div>
  );
}

function Legend(): ReactElement {
  const dot = "inline-block size-2.5 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.12)]";
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" data-testid="timeline-legend">
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-6 rounded-sm bg-primary/50" /> {t("timeline.legend.spend")}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-3 w-0.5 bg-foreground/70" /> {t("timeline.legend.projected")}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-1 w-6 rounded-full bg-inverse/75" /> {t("timeline.legend.target")}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-3 w-0.5 bg-destructive/80" /> {t("timeline.today")}
      </span>
      {(["approval", "alert", "comment", "version"] as const).map((k) => (
        <span key={k} className="inline-flex items-center gap-1.5">
          <span className={`${dot} ${k === "approval" ? "bg-success" : k === "alert" ? "bg-destructive" : k === "comment" ? "bg-warning" : "bg-primary"}`} /> {t(`timeline.marker.${k}`)}
        </span>
      ))}
    </div>
  );
}
