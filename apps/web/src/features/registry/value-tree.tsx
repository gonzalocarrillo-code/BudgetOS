import { Button, cn } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useMutation } from "@tanstack/react-query";
import { ChevronRight, CornerDownRight, GripVertical } from "lucide-react";
import { useState, type DragEvent, type ReactElement } from "react";
import { api, unwrap } from "../../lib/api.js";
import type { Dimension, DimensionValue } from "../../lib/queries.js";
import { flattenTree, parseValueLines, subtreeIds } from "./values.js";

type Op =
  | { kind: "add"; lines: ReturnType<typeof parseValueLines> }
  | { kind: "patch"; id: string; body: { label?: string; parentCode?: string | null; isActive?: boolean } }
  | { kind: "merge"; id: string; fromCode: string; intoCode: string };

/**
 * ValueTree (spec §18.5, plan 0.6): a granularity's values as a tree. Add many at once
 * (`Parent > Child` nests), add a child under a value, move a value (with its children) under
 * another by drag and drop or the "Move under" list, rename (the code stays), retire / restore,
 * merge into another (the old code stays as an alias). `blocked` is why the caller cannot change it.
 */
export function ValueTree({ ws, dim, blocked, onChanged }: { ws: string; dim: Dimension; blocked: string | null; onChanged: () => Promise<void> }): ReactElement {
  const [adding, setAdding] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const op = useMutation({
    mutationFn: async (o: Op) => {
      const header = { "X-Workspace-Id": ws };
      if (o.kind === "add") return unwrap(api.POST("/api/v1/dimensions/{id}/values", { params: { path: { id: dim.id }, header }, body: { values: o.lines } as never }));
      if (o.kind === "patch") return unwrap(api.PATCH("/api/v1/values/{id}", { params: { path: { id: o.id }, header }, body: o.body as never }));
      return unwrap(api.POST("/api/v1/values/{id}/merge", { params: { path: { id: o.id }, header }, body: { fromCode: o.fromCode, intoCode: o.intoCode } as never }));
    },
    onSuccess: async (_, o) => {
      if (o.kind === "add") setAdding("");
      await onChanged();
    },
  });
  const values = dim.values;
  const visible = values.filter((v) => showRetired || v.isActive);
  const tree = flattenTree(visible);
  const byId = new Map(values.map((v) => [v.id, v]));
  const lines = parseValueLines(adding, values);
  const move = (v: DimensionValue, parentCode: string | null) => op.mutate({ kind: "patch", id: v.id, body: { parentCode } });
  const onDrop = (e: DragEvent, target: DimensionValue | null) => {
    e.preventDefault();
    const v = dragging ? byId.get(dragging) : undefined;
    setDragging(null);
    if (!v || blocked) return;
    if (target && subtreeIds(values, v.id).has(target.id)) return;
    if ((target?.id ?? null) !== v.parentValueId) move(v, target?.code ?? null);
  };
  const addWhy = blocked ?? (lines.length === 0 ? t("registry.values.nothing") : op.isPending ? t("shell.loading") : null);

  return (
    <div className="flex flex-col gap-4" data-testid="value-tree">
      <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t("registry.values.add")}
          <textarea className="min-h-20 rounded-lg border border-input bg-card p-2 font-mono text-sm outline-none focus:border-ring" value={adding} onChange={(e) => setAdding(e.target.value)} placeholder={t("registry.values.placeholder")} data-testid="values-input" />
          <span className="text-xs font-normal text-muted-foreground">{t("registry.values.help")}</span>
        </label>
        <div className="flex items-center justify-end gap-2">
          {lines.length ? <span className="mr-auto text-xs text-muted-foreground">{t("registry.values.preview", { n: lines.length })}</span> : null}
          {addWhy ? (
            <Button size="sm" disabled reason={addWhy} data-testid="values-add">
              {t("registry.values.addButton")}
            </Button>
          ) : (
            <Button size="sm" onClick={() => op.mutate({ kind: "add", lines })} data-testid="values-add">
              {t("registry.values.addButton")}
            </Button>
          )}
        </div>
      </div>
      {op.error ? <p role="alert" className="text-sm text-destructive">{op.error.message}</p> : null}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{t("registry.values.count", { n: values.filter((v) => v.isActive).length })}</span>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} />
          {t("registry.values.showRetired")}
        </label>
      </div>
      {tree.length === 0 ? <p className="text-sm text-muted-foreground">{t("registry.values.empty")}</p> : null}
      <div
        className={cn("rounded-lg border border-dashed px-3 py-1.5 text-xs text-muted-foreground", dragging ? "border-primary" : "hidden")}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => onDrop(e, null)}
        data-testid="drop-top"
      >
        {t("registry.values.dropTop")}
      </div>
      <ul className="flex flex-col" aria-label={t("registry.values.title", { name: dim.label })}>
        {tree.map(({ value: v, depth }) => {
          const parent = v.parentValueId ? byId.get(v.parentValueId) : undefined;
          const merged = v.mergedIntoId ? byId.get(v.mergedIntoId) : undefined;
          const isOpen = open === v.id;
          return (
            <li key={v.id} className="border-b border-border last:border-b-0" data-testid="value-row" data-code={v.code}>
              <div
                className={cn("flex items-center gap-2 py-1.5 pr-1 text-sm", !v.isActive ? "text-muted-foreground" : "", dragging && dragging !== v.id ? "hover:bg-secondary" : "")}
                style={{ paddingLeft: `${depth * 1.25}rem` }}
                draggable={!blocked && v.isActive}
                onDragStart={(e) => (e.dataTransfer.setData("text/plain", v.id), setDragging(v.id))}
                onDragEnd={() => setDragging(null)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => onDrop(e, v)}
              >
                {!blocked && v.isActive ? <GripVertical className="size-3.5 shrink-0 cursor-grab text-muted-foreground" aria-hidden /> : <span className="w-3.5" />}
                {depth > 0 ? <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /> : null}
                <span className={cn("min-w-0 truncate", !v.isActive ? "line-through" : "font-medium")} data-testid="value-label">
                  {v.label}
                </span>
                <code className="text-xs text-muted-foreground">{v.code}</code>
                {parent ? <span className="sr-only">{t("registry.values.under", { name: parent.label })}</span> : null}
                {merged ? <span className="rounded-full bg-surface px-2 text-xs">{t("registry.values.mergedInto", { name: merged.label })}</span> : !v.isActive ? <span className="rounded-full bg-surface px-2 text-xs">{t("registry.values.retired")}</span> : null}
                {v.aliases.length ? <span className="truncate text-xs text-muted-foreground">{t("registry.values.aliases", { codes: v.aliases.join(", ") })}</span> : null}
                <button type="button" className="ml-auto inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent" aria-expanded={isOpen} aria-label={t("registry.values.actions", { name: v.label })} onClick={() => setOpen(isOpen ? null : v.id)} data-testid="value-actions">
                  {t("registry.values.edit")}
                  <ChevronRight className={cn("size-3.5 transition-transform", isOpen ? "rotate-90" : "")} aria-hidden />
                </button>
              </div>
              {isOpen ? <ValueActions v={v} values={values} blocked={blocked} pending={op.isPending} onOp={(o) => op.mutate(o)} onMove={move} /> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ValueActions({ v, values, blocked, pending, onOp, onMove }: { v: DimensionValue; values: DimensionValue[]; blocked: string | null; pending: boolean; onOp: (o: Op) => void; onMove: (v: DimensionValue, parentCode: string | null) => void }): ReactElement {
  const [label, setLabel] = useState(v.label);
  const [child, setChild] = useState("");
  const [into, setInto] = useState("");
  const inside = subtreeIds(values, v.id);
  const targets = values.filter((x) => x.isActive && !inside.has(x.id));
  const why = blocked ?? (pending ? t("shell.loading") : null);
  const field = "h-8 min-w-0 flex-1 rounded-md border border-input bg-card px-2 text-sm outline-none focus:border-ring";
  const act = (ok: boolean, run: () => void, text: string, testId: string, variant: "outline" | "destructive" = "outline") =>
    why || !ok ? (
      <Button size="sm" variant={variant} disabled reason={why ?? t("registry.values.fillFirst")} data-testid={testId}>
        {text}
      </Button>
    ) : (
      <Button size="sm" variant={variant} onClick={run} data-testid={testId}>
        {text}
      </Button>
    );
  return (
    <div className="mb-2 ml-6 grid gap-2 rounded-lg bg-surface p-3 text-sm" data-testid="value-panel">
      <div className="flex gap-2">
        <input className={field} value={label} onChange={(e) => setLabel(e.target.value)} aria-label={t("registry.values.rename")} data-testid="value-rename-input" />
        {act(label.trim() !== "" && label.trim() !== v.label, () => onOp({ kind: "patch", id: v.id, body: { label: label.trim() } }), t("registry.values.rename"), "value-rename")}
      </div>
      {v.isActive ? (
        <>
          <div className="flex gap-2">
            <input className={field} value={child} onChange={(e) => setChild(e.target.value)} placeholder={t("registry.values.childPlaceholder", { name: v.label })} aria-label={t("registry.values.addChild")} data-testid="value-child-input" />
            {act(parseValueLines(child, values).length > 0, () => onOp({ kind: "add", lines: parseValueLines(child, values).map((l) => ({ ...l, parentCode: l.parentCode ?? v.code })) }), t("registry.values.addChild"), "value-child-add")}
          </div>
          <label className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-muted-foreground">{t("registry.values.moveUnder")}</span>
            <select className={field} value={values.find((x) => x.id === v.parentValueId)?.code ?? ""} disabled={why !== null} aria-disabled={why !== null} title={why ?? undefined} onChange={(e) => onMove(v, e.target.value || null)} data-testid="value-move">
              <option value="">{t("registry.values.topLevel")}</option>
              {targets.map((x) => (
                <option key={x.id} value={x.code}>
                  {x.path.split(".").length > 1 ? `${"· ".repeat(x.path.split(".").length - 1)}${x.label}` : x.label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-2">
            <select className={field} value={into} onChange={(e) => setInto(e.target.value)} aria-label={t("registry.values.mergeInto")} data-testid="value-merge-into">
              <option value="">{t("registry.values.mergeInto")}</option>
              {values.filter((x) => x.isActive && x.id !== v.id).map((x) => (
                <option key={x.id} value={x.code}>
                  {x.label}
                </option>
              ))}
            </select>
            {act(into !== "", () => onOp({ kind: "merge", id: v.id, fromCode: v.code, intoCode: into }), t("registry.values.merge"), "value-merge")}
          </div>
          <div className="flex justify-end">{act(true, () => onOp({ kind: "patch", id: v.id, body: { isActive: false } }), t("registry.values.retire"), "value-retire", "destructive")}</div>
        </>
      ) : v.mergedIntoId ? null : (
        <div className="flex justify-end">{act(true, () => onOp({ kind: "patch", id: v.id, body: { isActive: true } }), t("registry.values.restore"), "value-restore")}</div>
      )}
    </div>
  );
}
