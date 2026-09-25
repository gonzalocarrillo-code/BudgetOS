import { Button, cn } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, ArrowDown, ArrowUp, ChevronRight, GripVertical, Star, X } from "lucide-react";
import { useState, type ReactElement } from "react";
import { api, unwrap } from "../../lib/api.js";
import type { Dimension, Template } from "../../lib/queries.js";
import { DimensionIcon } from "./dimension-icon.js";

/** Why a level cannot sit under the one above it (the API refuses the same), or null. */
export function levelProblem(path: string[], i: number, dims: Dimension[]): string | null {
  const d = dims.find((x) => x.key === path[i]);
  if (!d) return t("registry.hierarchy.unknown");
  const parent = path[i - 1];
  if (i === 0 || parent === undefined || d.allowedParents.length === 0 || d.allowedParents.includes(parent)) return null;
  return t("registry.hierarchy.cannotNest", { child: d.label, parent: dims.find((x) => x.key === parent)?.label ?? parent, allowed: d.allowedParents.join(", ") });
}

/**
 * HierarchyBuilder (spec §18.5): the ordered paths the Explorer's tree follows. Pick a template or
 * start one; add levels, reorder them (drag, or the arrow buttons), remove them; make one the
 * default. Envelopes never change, only the tree does. A level that cannot nest where it sits says why.
 */
export function HierarchyBuilder({ ws, dims, templates, blocked, onSaved }: { ws: string; dims: Dimension[]; templates: Template[]; blocked: string | null; onSaved: () => Promise<void> }): ReactElement {
  const [selected, setSelected] = useState<string>(templates.find((x) => x.isDefault)?.id ?? templates[0]?.id ?? "new");
  const current = templates.find((x) => x.id === selected) ?? null;
  return (
    <div className="grid gap-5 lg:grid-cols-[16rem_1fr]">
      <ul className="flex flex-col gap-1" aria-label={t("registry.hierarchy.templates")} data-testid="template-list">
        {templates.map((x) => (
          <li key={x.id}>
            <button type="button" aria-current={selected === x.id} className={cn("flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm", selected === x.id ? "bg-primary text-primary-foreground" : "hover:bg-accent")} onClick={() => setSelected(x.id)} data-testid="template-item">
              <span className="min-w-0 flex-1 truncate">{x.name}</span>
              {x.isDefault ? <Star className="size-3.5" aria-label={t("registry.hierarchy.default")} /> : null}
            </button>
          </li>
        ))}
        <li>
          <button type="button" className={cn("w-full rounded-lg border border-dashed border-border px-3 py-2 text-left text-sm", selected === "new" ? "border-primary text-primary" : "text-muted-foreground hover:bg-accent")} onClick={() => setSelected("new")} data-testid="template-new">
            {t("registry.hierarchy.new")}
          </button>
        </li>
      </ul>
      <TemplateEditor key={selected} ws={ws} dims={dims} template={current} blocked={blocked} onSaved={async (id) => (setSelected(id), await onSaved())} />
    </div>
  );
}

function TemplateEditor({ ws, dims, template, blocked, onSaved }: { ws: string; dims: Dimension[]; template: Template | null; blocked: string | null; onSaved: (id: string) => Promise<void> }): ReactElement {
  const [name, setName] = useState(template?.name ?? "");
  const [path, setPath] = useState<string[]>(template?.path ?? []);
  const [isDefault, setIsDefault] = useState(template?.isDefault ?? false);
  const [drag, setDrag] = useState<number | null>(null);
  const active = dims.filter((d) => d.isActive);
  const unused = active.filter((d) => !path.includes(d.key));
  const problems = path.map((_, i) => levelProblem(path, i, dims));
  const save = useMutation({
    mutationFn: async () => {
      if (template) {
        const body = { ...(name.trim() !== template.name ? { name: name.trim() } : {}), path, ...(isDefault && !template.isDefault ? { isDefault: true } : {}) };
        return (await unwrap(api.PATCH("/api/v1/hierarchy-templates/{id}", { params: { path: { id: template.id }, header: { "X-Workspace-Id": ws } }, body: body as never }))) as unknown as { id: string };
      }
      return (await unwrap(api.POST("/api/v1/workspaces/{ws}/hierarchy-templates", { params: { path: { ws } }, body: { name: name.trim(), path, isDefault } as never }))) as unknown as { id: string };
    },
    onSuccess: (r) => onSaved(r.id),
  });
  const swap = (i: number, j: number) => {
    const next = [...path];
    const a = next[i];
    const b = next[j];
    if (a === undefined || b === undefined) return;
    next[i] = b;
    next[j] = a;
    setPath(next);
  };
  const moveTo = (from: number, to: number) => {
    const next = [...path];
    const [item] = next.splice(from, 1);
    if (item !== undefined) next.splice(to, 0, item);
    setPath(next);
  };
  const why = blocked ?? (!name.trim() ? t("registry.hierarchy.needName") : path.length === 0 ? t("registry.hierarchy.needLevel") : problems.find((p) => p !== null) ?? (save.isPending ? t("shell.loading") : null));
  const label = (key: string) => dims.find((d) => d.key === key)?.label ?? key;

  return (
    <div className="flex flex-col gap-4" data-testid="template-editor">
      <label className="flex max-w-sm flex-col gap-1 text-sm font-medium">
        {t("registry.hierarchy.name")}
        <input className="h-9 rounded-lg border border-input bg-card px-2 text-sm outline-none focus:border-ring" value={name} onChange={(e) => setName(e.target.value)} data-testid="template-name" />
      </label>
      <div>
        <p className="mb-2 text-sm font-medium">{t("registry.hierarchy.levels")}</p>
        <ol className="flex flex-col gap-1.5" aria-label={t("registry.hierarchy.levels")} data-testid="template-levels">
          {path.map((key, i) => {
            const d = dims.find((x) => x.key === key);
            const problem = problems[i];
            return (
              <li
                key={key}
                draggable={!blocked}
                onDragStart={() => setDrag(i)}
                onDragEnd={() => setDrag(null)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => (e.preventDefault(), drag !== null && drag !== i && moveTo(drag, i), setDrag(null))}
                className={cn("flex items-center gap-2 rounded-lg border bg-card px-2 py-1.5 text-sm", problem ? "border-warning" : "border-border", drag === i ? "opacity-50" : "")}
                style={{ marginLeft: `${i * 1}rem` }}
                data-testid="template-level"
                data-key={key}
              >
                <GripVertical className="size-4 cursor-grab text-muted-foreground" aria-hidden />
                <span className="w-5 text-xs text-muted-foreground">{i + 1}</span>
                {d ? <DimensionIcon ws={ws} icon={d.icon} /> : null}
                <span className="font-medium">{label(key)}</span>
                {problem ? (
                  <span className="inline-flex items-center gap-1 text-xs text-foreground" role="note">
                    <AlertTriangle className="size-3.5 text-warning" aria-hidden />
                    {problem}
                  </span>
                ) : null}
                <span className="ml-auto flex gap-0.5">
                  <button type="button" className="rounded p-1 hover:bg-accent disabled:opacity-30" aria-label={t("registry.hierarchy.up", { name: label(key) })} onClick={() => swap(i, i - 1)} disabled={i === 0} aria-disabled={i === 0} title={t("registry.hierarchy.first")}>
                    <ArrowUp className="size-3.5" aria-hidden />
                  </button>
                  <button type="button" className="rounded p-1 hover:bg-accent disabled:opacity-30" aria-label={t("registry.hierarchy.down", { name: label(key) })} onClick={() => swap(i, i + 1)} disabled={i === path.length - 1} aria-disabled={i === path.length - 1} title={t("registry.hierarchy.last")}>
                    <ArrowDown className="size-3.5" aria-hidden />
                  </button>
                  <button type="button" className="rounded p-1 hover:bg-accent" aria-label={t("registry.hierarchy.remove", { name: label(key) })} onClick={() => setPath(path.filter((_, j) => j !== i))} data-testid="template-remove">
                    <X className="size-3.5" aria-hidden />
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
        {unused.length ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5" role="group" aria-label={t("registry.hierarchy.add")}>
            <span className="text-xs text-muted-foreground">{t("registry.hierarchy.add")}</span>
            {unused.map((d) => (
              <button key={d.key} type="button" className="inline-flex h-7 items-center gap-1.5 rounded-full border border-dashed border-border px-2.5 text-xs hover:bg-accent" onClick={() => setPath([...path, d.key])} data-testid="template-add" data-key={d.key}>
                <DimensionIcon ws={ws} icon={d.icon} className="size-3.5" />
                {d.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {path.length ? (
        <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground" data-testid="template-preview">
          {t("registry.hierarchy.preview")}
          {path.map((k, i) => (
            <span key={k} className="inline-flex items-center gap-1">
              {i > 0 ? <ChevronRight className="size-3" aria-hidden /> : null}
              {label(k)}
            </span>
          ))}
        </p>
      ) : null}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} disabled={template?.isDefault === true} aria-disabled={template?.isDefault === true} title={t("registry.hierarchy.isDefault")} />
        {t("registry.hierarchy.makeDefault")}
      </label>
      {save.error ? <p role="alert" className="text-sm text-destructive">{save.error.message}</p> : null}
      <div className="flex justify-end">
        {why ? (
          <Button disabled reason={why} data-testid="template-save">
            {t("registry.hierarchy.save")}
          </Button>
        ) : (
          <Button onClick={() => save.mutate()} data-testid="template-save">
            {t("registry.hierarchy.save")}
          </Button>
        )}
      </div>
    </div>
  );
}
