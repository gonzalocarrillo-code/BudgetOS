import { parseSearch } from "@budget/domain";
import { t, type MessageKey } from "@budget/ui/i18n";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import { Search } from "lucide-react";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { searchQuery, suggestQuery, type Dimension } from "../../lib/queries.js";
import { isQualifierToken, lastToken, qualifiersAsFilter, replaceLastToken } from "./query.js";

/**
 * Global search (spec §18.4, plan §11.3): ⌘K or `/` anywhere, or the header box. Results grouped
 * by type (top 5, "See all N"), qualifier chips, and autocomplete of qualifier keys and values
 * from /search/suggest (registry dimensions included, read live). Enter opens the highlighted
 * result; ⇧Enter opens the Explorer filtered by the dimension qualifiers.
 */

export const typeLabel = (type: string): string => {
  const key = `search.type.${type}` as MessageKey;
  return t(key) === key ? type : t(key);
};

export function useSearchHotkeys(open: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target?.closest("input, textarea, select, [contenteditable=true]") !== null && target !== null;
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        open();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
}

export function GlobalSearch({ ws, dimensions, open, onOpenChange }: { ws: string; dimensions: Dimension[]; open: boolean; onOpenChange: (open: boolean) => void }): ReactElement {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const token = lastToken(q);
  const qualifying = isQualifierToken(token);
  const parsed = useMemo(() => parseSearch(q), [q]);
  // A qualifier key still being typed is not searched: "brazil reg" searches "brazil" while `reg`
  // completes to `region:`. A `key:value` token is searched as it stands.
  const typingKey = qualifying && !token.includes(":");
  const trimmed = (typingKey ? q.slice(0, q.length - token.length) : q).trim();
  const shown = q.trim();
  const { data: results, isFetching } = useQuery({ ...searchQuery(ws, trimmed), enabled: open && trimmed.length >= 2, placeholderData: keepPreviousData });
  const { data: suggest } = useQuery({ ...suggestQuery(ws, token.replace(/^-/, "")), enabled: open && qualifying });
  const dimensionKeys = useMemo(() => new Set(dimensions.map((d) => d.key)), [dimensions]);

  const close = () => {
    onOpenChange(false);
    setQ("");
  };
  const go = (href: string) => {
    close();
    void navigate({ href });
  };
  const openInExplorer = () => {
    close();
    void navigate({ to: "/w/$ws/budgets", params: { ws }, search: { filter: qualifiersAsFilter(q, dimensionKeys) } as never });
  };
  const neg = token.startsWith("-") ? "-" : "";
  const keyOfToken = token.includes(":") ? token.replace(/^-/, "").split(":")[0] : null;

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
      shouldFilter={false}
      label={t("search.palette")}
      overlayClassName="fixed inset-0 z-40 bg-inverse/30"
      contentClassName="fixed left-1/2 top-24 z-50 w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-card shadow-lg"
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.shiftKey) {
          e.preventDefault();
          openInExplorer();
        }
      }}
    >
      <div className="flex items-center gap-2 border-b border-border px-4">
        <Search className="size-4 text-muted-foreground" aria-hidden />
        <Command.Input value={q} onValueChange={setQ} placeholder={t("search.placeholder")} className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" data-testid="search-input" />
      </div>
      {parsed.qualifiers.length ? (
        <div className="flex flex-wrap gap-1.5 border-b border-border px-4 py-2" data-testid="search-chips">
          {parsed.qualifiers.map((qual, i) => (
            <span key={i} className="rounded-full bg-secondary px-2.5 py-0.5 text-xs text-secondary-foreground" data-testid="search-chip">
              {qual.op === "neq" ? "−" : ""}
              {qual.key}: {qual.op === "gt" ? ">" : qual.op === "lt" ? "<" : ""}
              {qual.value}
            </span>
          ))}
        </div>
      ) : null}
      <Command.List className="max-h-[60vh] overflow-y-auto p-2" data-testid="search-list">
        {qualifying && suggest && (keyOfToken ? suggest.values.length : suggest.keys.length) ? (
          <Command.Group heading={keyOfToken ? t("search.values", { key: keyOfToken }) : t("search.qualifiers")} className="search-group" data-testid="search-suggestions">
            {keyOfToken
              ? suggest.values.map((v) => (
                  <Command.Item key={v.value} value={`suggest-value-${v.value}`} onSelect={() => setQ(replaceLastToken(q, `${neg}${keyOfToken}:${/\s/.test(v.value) ? `"${v.value}"` : v.value}`))} className="search-item" data-testid="search-suggestion">
                    <span className="font-medium">{v.value}</span>
                    {v.label !== v.value ? <span className="text-muted-foreground">{v.label}</span> : null}
                  </Command.Item>
                ))
              : suggest.keys.map((k) => (
                  <Command.Item key={k.key} value={`suggest-key-${k.key}`} onSelect={() => setQ(replaceLastToken(q, `${neg}${k.key}:`))} className="search-item" data-testid="search-suggestion">
                    <span className="font-medium">{k.key}:</span>
                    <span className="text-muted-foreground">{k.label}</span>
                  </Command.Item>
                ))}
          </Command.Group>
        ) : null}
        {trimmed.length < 2 && !qualifying ? <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t("search.hint")}</p> : null}
        {trimmed.length >= 2 && results && results.groups.length === 0 && !isFetching ? <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">{t("search.noResults", { q: shown })}</Command.Empty> : null}
        {trimmed.length >= 2 && !results && isFetching ? <Command.Loading className="px-3 py-6 text-center text-sm text-muted-foreground">{t("search.loading")}</Command.Loading> : null}
        {trimmed.length >= 2 && results
          ? results.groups.map((g) => (
              <Command.Group key={g.type} heading={`${typeLabel(g.type)} · ${g.count}`} className="search-group" data-testid={`search-group-${g.type}`}>
                {g.hits.map((h) => (
                  <Command.Item key={h.id} value={`hit-${g.type}-${h.id}`} onSelect={() => go(h.deepLink)} className="search-item" data-testid="search-hit">
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{h.title}</span>
                      {h.path ? <span className="ml-2 text-xs text-muted-foreground">{h.path}</span> : null}
                    </span>
                    {h.status ? <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{h.status.toLowerCase()}</span> : null}
                  </Command.Item>
                ))}
                {g.count > g.hits.length ? (
                  <Command.Item value={`all-${g.type}`} onSelect={() => go(`/w/${ws}/search?q=${encodeURIComponent(JSON.stringify(trimmed))}&type=${encodeURIComponent(JSON.stringify(g.type))}`)} className="search-item text-secondary-foreground" data-testid="search-see-all">
                    {t("search.seeAll", { count: g.count, type: typeLabel(g.type) })}
                  </Command.Item>
                ) : null}
              </Command.Group>
            ))
          : null}
        {shown.length >= 2 ? (
          <Command.Group className="search-group">
            <Command.Item value="all-results" onSelect={() => go(`/w/${ws}/search?q=${encodeURIComponent(JSON.stringify(shown))}`)} className="search-item" data-testid="search-all">
              {t("search.all", { q: shown })}
            </Command.Item>
            {parsed.qualifiers.some((x) => dimensionKeys.has(x.key)) ? (
              <Command.Item value="open-explorer" onSelect={openInExplorer} className="search-item" data-testid="search-explorer">
                {t("search.explorer")} <kbd className="ml-auto text-xs text-muted-foreground">⇧↵</kbd>
              </Command.Item>
            ) : null}
          </Command.Group>
        ) : null}
      </Command.List>
    </Command.Dialog>
  );
}
