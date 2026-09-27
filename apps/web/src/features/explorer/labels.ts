import { t } from "@budget/ui/i18n";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { meQuery, registryQuery } from "../../lib/queries.js";
import type { Labels } from "./row-source.js";

type Dimension = { key: string; label: string; values: ReadonlyArray<{ code: string; label: string }> };

/**
 * The Explorer's labels: a value's registry label, and what a group with no value is called. At
 * the first level that is the account (the workspace) itself — "Golden", not "(none)": budgets
 * with no client are the account's own. Deeper, "No <granularity>".
 */
export function explorerLabels(dimensions: readonly Dimension[], account: string | null): Labels {
  const values = new Map(dimensions.map((d) => [d.key, new Map(d.values.map((v) => [v.code, v.label]))]));
  const dimension = new Map(dimensions.map((d) => [d.key, d.label]));
  return {
    value: (dim, code) => values.get(dim)?.get(code) ?? code,
    none: (dim, level) => (level === 0 && account !== null ? account : t("explorer.noneOf", { dimension: dimension.get(dim) ?? dim })),
  };
}

export function useExplorerLabels(ws: string): Labels {
  const { data: dimensions = [] } = useQuery(registryQuery(ws));
  const { data: me } = useQuery(meQuery);
  const account = me?.workspaces.find((w) => w.workspaceId === ws)?.name ?? null;
  return useMemo(() => explorerLabels(dimensions, account), [dimensions, account]);
}
