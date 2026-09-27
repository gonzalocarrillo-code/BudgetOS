import { Button, cn } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { FlaskConical, Plus } from "lucide-react";
import { useState, type ReactElement } from "react";
import { z } from "zod";
import { Card, Page } from "../components/page.js";
import { CreateExperimentDialog, StatusBadge } from "../features/experiments/components.js";
import { STATUSES, experimentsQuery } from "../features/experiments/queries.js";
import { can } from "../features/ops/queries.js";
import { meQuery, registryQuery } from "../lib/queries.js";

/** Experiments list (spec §25, T-038): newest first, filtered by status in the URL; "New experiment". */
const ListSearch = z.object({ status: z.enum(STATUSES).optional() });
type ListSearch = z.infer<typeof ListSearch>;
export const Route = createFileRoute("/w/$ws/experiments/")({ validateSearch: ListSearch, component: ExperimentsPage });

function ExperimentsPage(): ReactElement {
  const { ws } = Route.useParams();
  const { status } = Route.useSearch();
  const navigate = Route.useNavigate();
  const client = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const { data: dimensions = [] } = useQuery(registryQuery(ws));
  const { data = [], isPending } = useQuery(experimentsQuery(ws, status));
  const [creating, setCreating] = useState(false);
  const perms = me?.workspaces.find((w) => w.workspaceId === ws)?.permissions ?? [];
  const blocked = can(perms, me?.isOrgAdmin ?? false, "envelope.edit_draft") ? null : t("experiments.noPermission");
  const chip = "h-8 rounded-full border px-3 text-sm";

  return (
    <Page
      title={t("nav.experiments")}
      actions={
        blocked ? (
          <Button disabled reason={blocked} data-testid="experiment-new">
            <Plus className="size-4" aria-hidden /> {t("experiments.new")}
          </Button>
        ) : (
          <Button onClick={() => setCreating(true)} data-testid="experiment-new">
            <Plus className="size-4" aria-hidden /> {t("experiments.new")}
          </Button>
        )
      }
    >
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("experiments.filterStatus")} data-testid="experiment-status-filter">
        {[undefined, ...STATUSES].map((s) => (
          <button key={s ?? "all"} type="button" aria-pressed={status === s} className={cn(chip, status === s ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-foreground/80 hover:bg-accent")} onClick={() => void navigate({ search: (prev: ListSearch) => ({ ...prev, status: s }) })} data-testid={`status-${s ?? "all"}`}>
            {s ? t(`experiments.status.${s}` as MessageKey) : t("experiments.all")}
          </button>
        ))}
      </div>
      <Card>
        {isPending ? (
          <p className="text-sm text-muted-foreground">{t("shell.loading")}</p>
        ) : data.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center" data-testid="experiments-empty">
            <FlaskConical className="size-8 text-subtle-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">{t("experiments.empty")}</p>
          </div>
        ) : (
          <table className="w-full text-sm" data-testid="experiments-table">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-2 font-medium">{t("experiments.col.name")}</th>
                <th className="py-2 font-medium">{t("experiments.col.kind")}</th>
                <th className="py-2 font-medium">{t("experiments.col.window")}</th>
                <th className="py-2 font-medium">{t("experiments.col.metric")}</th>
                <th className="py-2 font-medium">{t("experiments.col.budgets")}</th>
                <th className="py-2 text-right font-medium">{t("experiments.col.status")}</th>
              </tr>
            </thead>
            <tbody>
              {data.map((x) => (
                <tr key={x.id} className="border-t border-border hover:bg-accent/60" data-testid="experiment-row">
                  <td className="py-2.5 pr-3">
                    <Link to="/w/$ws/experiments/$id" params={{ ws, id: x.id }} className="font-medium text-foreground hover:text-primary" data-testid="experiment-link">
                      {x.name}
                    </Link>
                    <p className="line-clamp-1 text-xs text-muted-foreground">{x.hypothesis}</p>
                  </td>
                  <td className="py-2.5 pr-3 text-muted-foreground">{t(`experiments.kind.${x.kind}` as MessageKey)}</td>
                  <td className="py-2.5 pr-3 tabular-nums text-muted-foreground">
                    {x.startDate} – {x.endDate}
                  </td>
                  <td className="py-2.5 pr-3 font-medium">{x.primaryMetric.toUpperCase()}</td>
                  <td className="py-2.5 pr-3 tabular-nums text-muted-foreground">{t("experiments.linkedCount", { test: x.envelopes.filter((e) => e.role === "TEST").length, control: x.envelopes.filter((e) => e.role === "CONTROL").length })}</td>
                  <td className="py-2.5 text-right">
                    <StatusBadge status={x.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {creating ? (
        <CreateExperimentDialog
          ws={ws}
          dimensions={dimensions}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            void client.invalidateQueries({ queryKey: ["experiments", ws] });
            void navigate({ to: "/w/$ws/experiments/$id", params: { ws, id } });
          }}
        />
      ) : null}
    </Page>
  );
}
