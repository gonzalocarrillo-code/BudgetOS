import type { FilterGroupT } from "@budget/domain";
import { BudgetGrid, type ColumnSpec, type GridEvents } from "@budget/grid";
import { Button } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useMemo, useState, type ReactElement } from "react";
import { Card, Page } from "../components/page.js";
import { useExplorerLabels } from "../features/explorer/labels.js";
import { ExplorerRowSource } from "../features/explorer/row-source.js";
import { useGridTheme } from "../features/explorer/grid-theme.js";
import { ConcludeDialog, CriterionBadge, LinkPicker, ReadoutCards, StatusBadge } from "../features/experiments/components.js";
import { experimentQuery, type Experiment } from "../features/experiments/queries.js";
import { can } from "../features/ops/queries.js";
import { api, unwrap } from "../lib/api.js";
import { meQuery } from "../lib/queries.js";

/**
 * One experiment (spec §25, T-038): the hypothesis, status actions, the criterion badge, test vs
 * control read-out cards from the planner, the linked budgets (the Explorer's grid on a fixed
 * filter) and the recorded decision. Conclude needs a decision and posts it on every linked budget.
 */
export const Route = createFileRoute("/w/$ws/experiments/$id")({ component: ExperimentPage });

const CURRENCY = "USD";
type Move = "start" | "evaluate" | "abandon";
const MOVES: Array<{ move: Move; from: Experiment["status"][]; variant: "default" | "outline" }> = [
  { move: "start", from: ["PLANNED"], variant: "default" },
  { move: "evaluate", from: ["RUNNING"], variant: "outline" },
  { move: "abandon", from: ["PLANNED", "RUNNING", "EVALUATING"], variant: "outline" },
];

function ExperimentPage(): ReactElement {
  const { ws, id } = Route.useParams();
  const client = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const { data, isPending, error } = useQuery(experimentQuery(ws, id));
  const [concluding, setConcluding] = useState(false);
  const perms = me?.workspaces.find((w) => w.workspaceId === ws)?.permissions ?? [];
  const blocked = can(perms, me?.isOrgAdmin ?? false, "envelope.edit_draft") ? null : t("experiments.noPermission");
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ["experiment", ws, id] }), client.invalidateQueries({ queryKey: ["experiments", ws] }), client.invalidateQueries({ queryKey: ["timeline", ws] })]);
  const move = useMutation({
    mutationFn: async (m: Move) => unwrap(api.POST(`/api/v1/experiments/{id}/${m}` as "/api/v1/experiments/{id}/start", { params: { path: { id }, header: { "X-Workspace-Id": ws } } })),
    onSuccess: refresh,
  });

  if (error) return <Page title={t("page.experiment")}><p role="alert" className="text-sm text-destructive">{error.message}</p></Page>;
  if (isPending || !data) return <Page title={t("page.experiment")}><p className="text-sm text-muted-foreground">{t("shell.loading")}</p></Page>;
  const { experiment: x, readout } = data;
  const final = x.status === "CONCLUDED" || x.status === "ABANDONED";
  const concludeWhy = blocked ?? (!["RUNNING", "EVALUATING"].includes(x.status) ? t("experiments.conclude.notRunning") : x.envelopes.length === 0 ? t("experiments.conclude.noEnvelopes") : null);

  return (
    <Page
      title={x.name}
      actions={
        <>
          {MOVES.filter((m) => m.from.includes(x.status)).map((m) =>
            blocked || move.isPending ? (
              <Button key={m.move} variant={m.variant} disabled reason={blocked ?? t("shell.loading")} data-testid={`experiment-${m.move}`}>
                {t(`experiments.action.${m.move}` as MessageKey)}
              </Button>
            ) : (
              <Button key={m.move} variant={m.variant} onClick={() => move.mutate(m.move)} data-testid={`experiment-${m.move}`}>
                {t(`experiments.action.${m.move}` as MessageKey)}
              </Button>
            ),
          )}
          {final ? null : concludeWhy ? (
            <Button disabled reason={concludeWhy} data-testid="experiment-conclude">
              {t("experiments.action.conclude")}
            </Button>
          ) : (
            <Button onClick={() => setConcluding(true)} data-testid="experiment-conclude">
              {t("experiments.action.conclude")}
            </Button>
          )}
        </>
      }
    >
      <Link to="/w/$ws/experiments" params={{ ws }} className="-mt-3 inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden /> {t("nav.experiments")}
      </Link>
      <Card>
        <div className="flex flex-col gap-3" data-testid="experiment-summary">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <StatusBadge status={x.status} />
            <span className="text-muted-foreground">{t(`experiments.kind.${x.kind}` as MessageKey)}</span>
            <span className="text-muted-foreground">·</span>
            <span className="tabular-nums text-muted-foreground">
              {x.startDate} – {x.endDate}
            </span>
          </div>
          <p className="text-[15px]" data-testid="experiment-hypothesis-text">
            {x.hypothesis}
          </p>
          <CriterionBadge experiment={x} readout={readout} />
          {move.error ? <p role="alert" className="text-sm text-destructive">{move.error.message}</p> : null}
        </div>
      </Card>
      <ReadoutCards experiment={x} readout={readout} currency={CURRENCY} />
      {x.decision ? (
        <Card title={t("experiments.decision")}>
          <p className="whitespace-pre-wrap text-sm" data-testid="experiment-decision">
            {x.decision}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">{t("experiments.decisionPosted", { count: x.envelopes.length, at: (x.decidedAt ?? "").slice(0, 10) })}</p>
        </Card>
      ) : null}
      <Card title={t("experiments.linked")}>
        <div className="flex flex-col gap-4">
          {final ? null : <LinkPicker ws={ws} experiment={x} blocked={blocked} onLinked={() => void refresh()} />}
          <div className="grid gap-4 lg:grid-cols-2">
            <LinkedGrid ws={ws} experiment={x} role="TEST" />
            <LinkedGrid ws={ws} experiment={x} role="CONTROL" />
          </div>
        </div>
      </Card>
      {concluding ? (
        <ConcludeDialog
          ws={ws}
          experiment={x}
          onClose={() => setConcluding(false)}
          onDone={() => {
            setConcluding(false);
            void refresh();
          }}
        />
      ) : null}
    </Page>
  );
}

/** The linked budgets of one role: the Explorer's grid over a fixed filter (`experiment` = `<id>:<role>`). */
function LinkedGrid({ ws, experiment, role }: { ws: string; experiment: Experiment; role: "TEST" | "CONTROL" }): ReactElement {
  const gridTheme = useGridTheme();
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState<{ total: number; totals: Record<string, string | null> } | null>(null);
  const count = experiment.envelopes.filter((e) => e.role === role).length;
  const labels = useExplorerLabels(ws);
  const filter: FilterGroupT = { logic: "and", children: [{ field: { kind: "attr", key: "experiment" }, op: "eq", value: `${experiment.id}:${role}` }] };
  const key = JSON.stringify([experiment.id, role, count, experiment.startDate, experiment.endDate]);
  const source = useMemo(
    () =>
      new ExplorerRowSource(
        { ws, view: "pivot", filter, period: { kind: "range", start: experiment.startDate, end: experiment.endDate }, measures: ["budget", "actual", "remaining"], levels: [], groupBy: [], expanded: [], sort: [{ key: "name", dir: "asc" }] },
        labels,
        () => undefined,
        (s) => setLoaded({ total: s.total, totals: s.totals }),
      ),
    // A new source when the links change.
    [key, labels],
  );
  const columns: ColumnSpec[] = [
    { kind: "path", width: 220, title: t("explorer.col.name") },
    { kind: "measure", key: "budget", title: t("explorer.col.budget"), width: 115 },
    { kind: "measure", key: "actual", title: t("explorer.col.actual"), width: 115 },
  ];
  // Read-only here: budgets are edited in the Explorer, which a row opens.
  const events: GridEvents = {
    onSelect: () => undefined,
    onEdit: async () => undefined,
    onPaste: () => undefined,
    onOpen: (row) => {
      if (row.envelopeId) void navigate({ to: "/w/$ws/budgets", params: { ws }, search: { select: row.envelopeId } as never });
    },
  };
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid={`linked-${role.toLowerCase()}`} data-rows={loaded?.total ?? ""}>
      <span className="text-sm font-semibold">{t(role === "TEST" ? "experiments.linkedTest" : "experiments.linkedControl", { count })}</span>
      {count === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">{t("experiments.linkedNone")}</p>
      ) : (
        <div className="h-64 min-w-0 overflow-hidden rounded-lg border border-border">
          <BudgetGrid key={key} source={source} columns={columns} events={events} totals={loaded?.totals ?? {}} currency={CURRENCY} theme={gridTheme} totalsLabel={t("explorer.totals")} />
        </div>
      )}
    </div>
  );
}
