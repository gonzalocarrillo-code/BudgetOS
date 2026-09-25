import { t } from "@budget/ui/i18n";
import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { z } from "zod";
import { Card, Page } from "../components/page.js";

/** Full search results (spec §18.4, T-028); the shell's search box lands here with `q`. */
export const Route = createFileRoute("/w/$ws/search")({ validateSearch: z.object({ q: z.string().max(500).default("") }), component: SearchPage });

function SearchPage(): ReactElement {
  const { q } = Route.useSearch();
  return (
    <Page title={t("nav.search")}>
      <Card>
      <p className="text-sm text-muted-foreground" data-testid="search-query">
        {q ? q : t("search.empty")}
      </p>
      <p className="text-sm text-muted-foreground" data-testid="page-pending">
        {t("page.pending", { task: "T-028" })}
      </p>
      </Card>
    </Page>
  );
}
