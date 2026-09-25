import { FilterGroup, Grain, PeriodSpec } from "@budget/domain";
import { t } from "@budget/ui/i18n";
import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { z } from "zod";
import { Card, Page } from "../components/page.js";

/** Explorer search params are the source of truth for filter / grouping state (spec §18.1). */
const ExplorerSearch = z.object({
  filter: FilterGroup.default({ logic: "and", children: [] }),
  groupBy: z.array(z.string()).default([]),
  templateId: z.string().uuid().optional(),
  measures: z.array(z.string()).default(["budget", "actual", "projected", "pace_index"]),
  targets: z.array(z.string()).default([]),
  period: PeriodSpec.default({ kind: "relative", preset: "current_quarter" }),
  grain: Grain.default("total"),
  asOf: z.string().datetime().optional(),
  view: z.enum(["tree", "pivot", "timeline"]).default("tree"),
  zoom: z.enum(["week", "month", "quarter", "fy"]).default("month"),
  select: z.string().uuid().optional(),
  savedViewId: z.string().uuid().optional(),
});

export const Route = createFileRoute("/w/$ws/budgets")({ validateSearch: ExplorerSearch, component: ExplorerPage });

function ExplorerPage(): ReactElement {
  const search = Route.useSearch();
  return (
    <Page title={t("nav.budgets")}>
      <Card>
      <p className="text-sm text-muted-foreground" data-testid="page-pending">
        {t("page.pending", { task: "T-027" })}
      </p>
      <p className="text-xs text-muted-foreground" data-testid="explorer-state">
        {search.view} · {search.period.kind} · {search.measures.join(", ")}
      </p>
      </Card>
    </Page>
  );
}
