import { cn } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { z } from "zod";
import { Card, Page } from "../components/page.js";
import { typeLabel } from "../features/search/global-search.js";
import { searchQuery } from "../lib/queries.js";

/** Full search results (spec §18.4): every group, up to 50 per type; `type` narrows to one. */
export const Route = createFileRoute("/w/$ws/search")({ validateSearch: z.object({ q: z.string().max(500).default(""), type: z.string().max(40).optional() }), component: SearchPage });

function SearchPage(): ReactElement {
  const { ws } = Route.useParams();
  const { q, type } = Route.useSearch();
  const navigate = useNavigate();
  const { data, isFetching } = useQuery({ ...searchQuery(ws, q, { types: type, limit: 50 }), enabled: q.trim().length >= 2 });
  const total = data?.groups.reduce((n, g) => n + g.count, 0) ?? 0;
  return (
    <Page title={t("nav.search")}>
      <p className="text-sm text-muted-foreground" data-testid="search-query">
        {q ? (data ? t("search.results", { count: total, q }) : q) : t("search.empty")}
      </p>
      {type ? (
        <div className="flex gap-2 text-sm">
          <span className="rounded-full bg-secondary px-2.5 py-0.5 text-secondary-foreground">{t("search.filterType", { type: typeLabel(type) })}</span>
          <Link to="/w/$ws/search" params={{ ws }} search={{ q }} className="text-secondary-foreground hover:underline">
            {t("search.allTypes")}
          </Link>
        </div>
      ) : null}
      {q && data && data.groups.length === 0 && !isFetching ? <Card><p className="text-sm text-muted-foreground">{t("search.noResults", { q })}</p></Card> : null}
      {data?.groups.map((g) => (
        <Card key={g.type} title={`${typeLabel(g.type)} · ${g.count}`}>
          <ul className="-mx-2 flex flex-col" data-testid={`results-${g.type}`}>
            {g.hits.map((h) => (
              <li key={h.id}>
                <a
                  href={h.deepLink}
                  onClick={(e) => {
                    e.preventDefault();
                    void navigate({ href: h.deepLink });
                  }}
                  className={cn("flex items-center gap-3 rounded-lg px-2 py-2 text-sm hover:bg-accent")}
                  data-testid="result-hit"
                >
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{h.title}</span>
                    {h.path ? <span className="ml-2 text-xs text-muted-foreground">{h.path}</span> : null}
                  </span>
                  {h.status ? <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{h.status.toLowerCase()}</span> : null}
                </a>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </Page>
  );
}
