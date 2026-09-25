import type { FilterGroupT, Predicate } from "@budget/domain";
import { Button } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { Plus, X } from "lucide-react";
import { useState, type ReactElement } from "react";
import type { Dimension } from "../../lib/queries.js";

/**
 * Filter chips (spec §18.3): one chip per top-level predicate of the URL's FilterGroup. "Add
 * filter" picks a registry dimension and its values (an `in` predicate). The filter is the AST
 * itself: chips never hold state of their own.
 */

const isPredicate = (n: FilterGroupT["children"][number]): n is Predicate => "field" in n;

function chipLabel(n: FilterGroupT["children"][number], dims: Dimension[]): string {
  if (!isPredicate(n) || n.field.kind !== "dimension") return t("explorer.filter.custom");
  const key = n.field.key;
  const dim = dims.find((d) => d.key === key);
  const label = (code: string) => dim?.values.find((v) => v.code === code)?.label ?? code;
  if (n.op === "is_empty") return t("explorer.filter.chipEmpty", { dimension: dim?.label ?? key });
  const values = Array.isArray(n.value) ? (n.value as string[]) : [String(n.value)];
  return t("explorer.filter.chip", { dimension: dim?.label ?? key, values: values.map(label).join(", ") });
}

export function FilterBar({ filter, dimensions, onChange }: { filter: FilterGroupT; dimensions: Dimension[]; onChange: (f: FilterGroupT) => void }): ReactElement {
  const [adding, setAdding] = useState(false);
  const [dimKey, setDimKey] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const dim = dimensions.find((d) => d.key === dimKey);
  const apply = () => {
    if (!dimKey || picked.length === 0) return;
    onChange({ ...filter, children: [...filter.children, { field: { kind: "dimension", key: dimKey }, op: "in", value: picked }] });
    setAdding(false);
    setDimKey("");
    setPicked([]);
  };
  return (
    <div className="flex flex-wrap items-center gap-2" data-tour="filter-bar" data-testid="filter-bar">
      {filter.children.map((n, i) => {
        const label = chipLabel(n, dimensions);
        return (
          <span key={i} className="inline-flex h-8 items-center gap-1 rounded-full border border-border bg-secondary pl-3 pr-1 text-sm text-secondary-foreground" data-testid="filter-chip">
            {label}
            <button type="button" className="grid size-6 place-items-center rounded-full hover:bg-primary/10" aria-label={t("explorer.filter.remove", { label })} onClick={() => onChange({ ...filter, children: filter.children.filter((_, j) => j !== i) })}>
              <X className="size-3.5" aria-hidden />
            </button>
          </span>
        );
      })}
      {adding ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-2 shadow-sm" data-testid="filter-editor">
          <select className="h-8 rounded-md border border-input bg-card px-2 text-sm" aria-label={t("explorer.filter.pickDimension")} value={dimKey} onChange={(e) => (setDimKey(e.target.value), setPicked([]))} data-testid="filter-dimension">
            <option value="">{t("explorer.filter.pickDimension")}</option>
            {dimensions.map((d) => (
              <option key={d.key} value={d.key}>
                {d.label}
              </option>
            ))}
          </select>
          {dim ? (
            <select
              multiple
              className="h-24 min-w-40 rounded-md border border-input bg-card px-2 text-sm"
              aria-label={t("explorer.filter.pickValues")}
              value={picked}
              onChange={(e) => setPicked([...e.target.selectedOptions].map((o) => o.value))}
              data-testid="filter-values"
            >
              {dim.values.map((v) => (
                <option key={v.code} value={v.code}>
                  {v.label}
                </option>
              ))}
            </select>
          ) : null}
          {picked.length ? (
            <Button size="sm" onClick={apply} data-testid="filter-apply">
              {t("explorer.filter.apply")}
            </Button>
          ) : (
            <Button size="sm" disabled reason={t("explorer.filter.pickValues")}>
              {t("explorer.filter.apply")}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setAdding(false)} aria-label={t("explorer.dismiss")}>
            <X className="size-4" aria-hidden />
          </Button>
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setAdding(true)} data-testid="filter-add">
          <Plus className="size-4" aria-hidden />
          {t("explorer.filter.add")}
        </Button>
      )}
      {filter.children.length ? (
        <Button size="sm" variant="ghost" onClick={() => onChange({ logic: "and", children: [] })}>
          {t("explorer.filter.clear")}
        </Button>
      ) : null}
    </div>
  );
}
