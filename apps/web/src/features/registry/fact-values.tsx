import { Button, Input } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useDeferredValue, type ReactElement } from "react";
import { factValuesQuery, type Dimension } from "../../lib/queries.js";
import { moneyOrDash } from "../../lib/money.js";

export const FACT_PAGE = 50;

/**
 * EX-9 (ADR-0094): a data-derived granularity (campaign) in the registry. Read-only — "From your
 * spend data": every value the facts carry, with its spend, first and last date and source, searched
 * and paged on the server. No add, edit, merge or retire: the API refuses those too. The search text
 * and page live in the registry page's URL (`vq`, `vp`).
 */
export function FactValues({ ws, dim, q, page, onSearch, onPage }: { ws: string; dim: Dimension; q: string; page: number; onSearch: (q: string) => void; onPage: (page: number) => void }): ReactElement {
  const search = useDeferredValue(q.trim());
  const { data, isPending, error } = useQuery({ ...factValuesQuery(ws, dim.key, { q: search, limit: FACT_PAGE, offset: page * FACT_PAGE }), placeholderData: keepPreviousData });
  const name = dim.label;
  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : page * FACT_PAGE + 1;
  const to = Math.min((page + 1) * FACT_PAGE, total);
  const last = to >= total;
  return (
    <div className="flex flex-col gap-3" data-testid="fact-values">
      <p className="text-sm text-muted-foreground">{t("registry.facts.help", { name: name.toLowerCase() })}</p>
      <label className="flex max-w-sm items-center gap-2 rounded-lg border border-input bg-card px-2">
        <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <Input type="search" size="sm" className="border-0 bg-transparent px-0 shadow-none hover:border-0 focus:ring-0" value={q} onChange={(e) => onSearch(e.target.value)} aria-label={t("registry.facts.search", { name })} placeholder={t("registry.facts.search", { name })} data-testid="fact-values-search" />
      </label>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      ) : isPending ? (
        <p className="text-sm text-muted-foreground">{t("shell.loading")}</p>
      ) : total === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="fact-values-empty">
          {search ? t("registry.facts.noMatch", { q: search }) : t("registry.facts.empty", { name: name.toLowerCase() })}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="fact-values-table">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-1.5 pr-3 font-medium">{t("registry.facts.col.name")}</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t("registry.facts.col.spend")}</th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">{t("registry.facts.col.firstSeen")}</th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">{t("registry.facts.col.lastSeen")}</th>
                  <th scope="col" className="py-1.5 font-medium">{t("registry.facts.col.source")}</th>
                </tr>
              </thead>
              <tbody>
                {data?.items.map((v) => (
                  <tr key={v.code} className="border-b border-border/60 last:border-0" data-testid="fact-value-row" data-value={v.code}>
                    <td className="max-w-80 truncate py-1.5 pr-3 font-medium" title={v.code}>{v.code}</td>
                    <td className="tabular py-1.5 pr-3 text-right">{moneyOrDash(v.spend, v.currency)}</td>
                    <td className="tabular py-1.5 pr-3 text-muted-foreground">{v.firstSeen}</td>
                    <td className="tabular py-1.5 pr-3 text-muted-foreground">{v.lastSeen}</td>
                    <td className="py-1.5 text-muted-foreground">{v.sourceSystems.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground" data-testid="fact-values-range">{t("registry.facts.range", { from, to, total })}</span>
            <span className="ml-auto flex gap-2">
              {page === 0 ? (
                <Button size="sm" variant="outline" disabled reason={t("registry.facts.onFirst")}>
                  {t("registry.facts.prev")}
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => onPage(page - 1)} data-testid="fact-values-prev">
                  {t("registry.facts.prev")}
                </Button>
              )}
              {last ? (
                <Button size="sm" variant="outline" disabled reason={t("registry.facts.onLast")}>
                  {t("registry.facts.next")}
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => onPage(page + 1)} data-testid="fact-values-next">
                  {t("registry.facts.next")}
                </Button>
              )}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
