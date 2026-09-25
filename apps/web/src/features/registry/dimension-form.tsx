import { Button, cn } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useMutation } from "@tanstack/react-query";
import { useState, type ReactElement } from "react";
import { z } from "zod";
import { api, unwrap } from "../../lib/api.js";
import type { Dimension } from "../../lib/queries.js";
import { DimensionIcon } from "./dimension-icon.js";
import { IconPicker } from "./icon-picker.js";
import { parseValueLines, toKey } from "./values.js";

const field = "h-9 w-full rounded-lg border border-input bg-card px-2 text-sm outline-none focus:border-ring";
const label = "flex flex-col gap-1 text-sm font-medium";

/**
 * DimensionForm (spec §18.5): a new granularity (label → key, icon from the library, where it can
 * nest, the first values, `Parent > Child` nesting) or the settings of an existing one. `blocked`
 * is why the caller cannot change it (a disabled Save says so).
 */
export function DimensionForm({ ws, dims, dim, isOrgAdmin, blocked, onSaved }: { ws: string; dims: Dimension[]; dim: Dimension | null; isOrgAdmin: boolean; blocked: string | null; onSaved: (id: string) => Promise<void> }): ReactElement {
  const [name, setName] = useState(dim?.label ?? "");
  const [key, setKey] = useState(dim?.key ?? "");
  const [keyTouched, setKeyTouched] = useState(false);
  const [description, setDescription] = useState(dim?.description ?? "");
  const [icon, setIcon] = useState(dim?.icon ?? "lucide:tag");
  const [parents, setParents] = useState<string[]>(dim?.allowedParents ?? []);
  const [required, setRequired] = useState(dim?.isRequiredForLeaf ?? false);
  const [orgWide, setOrgWide] = useState(false);
  const [values, setValues] = useState("");
  const effectiveKey = dim ? dim.key : keyTouched ? key : toKey(name);
  const others = dims.filter((d) => d.key !== effectiveKey && d.isActive);

  const save = useMutation({
    mutationFn: async () => {
      const H = { params: { header: { "X-Workspace-Id": ws } } };
      if (dim) {
        await unwrap(api.PATCH("/api/v1/dimensions/{id}", { params: { path: { id: dim.id }, header: { "X-Workspace-Id": ws } }, body: { label: name.trim(), description: description.trim() || null, icon, allowedParents: parents, isRequiredForLeaf: required } as never }));
        return dim.id;
      }
      const created = z.object({ id: z.string() }).parse(
        await unwrap(api.POST("/api/v1/workspaces/{ws}/dimensions", { params: { path: { ws } }, body: { key: effectiveKey, label: name.trim(), ...(description.trim() ? { description: description.trim() } : {}), dataType: "ENUM", icon, allowedParents: parents, isRequiredForLeaf: required, workspaceId: orgWide ? null : ws } as never })),
      );
      const lines = parseValueLines(values);
      if (lines.length) await unwrap(api.POST("/api/v1/dimensions/{id}/values", { params: { path: { id: created.id }, ...H.params }, body: { values: lines } as never }));
      return created.id;
    },
    onSuccess: (id) => onSaved(id),
  });
  const invalid = !name.trim() ? t("registry.form.needLabel") : !/^[a-z][a-z0-9_]{1,40}$/.test(effectiveKey) ? t("registry.form.badKey") : null;
  const why = blocked ?? invalid ?? (save.isPending ? t("shell.loading") : null);

  return (
    <form
      className="flex flex-col gap-4"
      aria-label={dim ? t("registry.form.editTitle", { name: dim.label }) : t("registry.form.newTitle")}
      onSubmit={(e) => {
        e.preventDefault();
        if (!why) save.mutate();
      }}
      data-testid="dimension-form"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className={label}>
          {t("registry.form.label")}
          <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("registry.form.labelHint")} data-testid="dim-label" />
        </label>
        <label className={label}>
          {t("registry.form.key")}
          <input className={cn(field, "font-mono", dim ? "bg-surface text-muted-foreground" : "")} value={effectiveKey} readOnly={dim !== null} onChange={(e) => (setKey(e.target.value), setKeyTouched(true))} aria-describedby="dim-key-help" data-testid="dim-key" />
          <span id="dim-key-help" className="text-xs font-normal text-muted-foreground">{t(dim ? "registry.form.keyFixed" : "registry.form.keyHelp", { key: effectiveKey || "…" })}</span>
        </label>
      </div>
      <label className={label}>
        {t("registry.form.description")}
        <input className={field} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-sm font-medium">{t("registry.form.icon")}</legend>
        <IconPicker ws={ws} value={icon} onChange={setIcon} />
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">{t("registry.form.parents")}</legend>
        <p className="text-xs text-muted-foreground">{t("registry.form.parentsHelp")}</p>
        <div className="flex flex-wrap gap-1.5">
          {others.map((d) => {
            const on = parents.includes(d.key);
            return (
              <button key={d.key} type="button" aria-pressed={on} className={cn("inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs", on ? "border-primary bg-secondary text-secondary-foreground" : "border-border hover:bg-accent")} onClick={() => setParents(on ? parents.filter((p) => p !== d.key) : [...parents, d.key])} data-testid="dim-parent" data-key={d.key}>
                <DimensionIcon ws={ws} icon={d.icon} className="size-3.5" />
                {d.label}
              </button>
            );
          })}
        </div>
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
        {t("registry.form.required")}
      </label>
      {!dim ? (
        <>
          {isOrgAdmin ? (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={orgWide} onChange={(e) => setOrgWide(e.target.checked)} data-testid="dim-org" />
              {t("registry.form.orgWide")}
            </label>
          ) : null}
          <label className={label}>
            {t("registry.form.values")}
            <textarea className="min-h-28 rounded-lg border border-input bg-card p-2 font-mono text-sm outline-none focus:border-ring" value={values} onChange={(e) => setValues(e.target.value)} placeholder={t("registry.values.placeholder")} data-testid="dim-values" />
            <span className="text-xs font-normal text-muted-foreground">{t("registry.values.help")}</span>
          </label>
        </>
      ) : null}
      {save.error ? <p role="alert" className="text-sm text-destructive">{save.error.message}</p> : null}
      <div className="flex justify-end">
        {why ? (
          <Button disabled reason={why} data-testid="dim-save">
            {t(dim ? "registry.form.save" : "registry.form.create")}
          </Button>
        ) : (
          <Button type="submit" data-testid="dim-save">
            {t(dim ? "registry.form.save" : "registry.form.create")}
          </Button>
        )}
      </div>
    </form>
  );
}
