import { cn } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useMutation } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import { useId, useState, type ReactElement } from "react";
import { z } from "zod";
import { api, unwrap } from "../../lib/api.js";
import { DimensionIcon, iconNames } from "./dimension-icon.js";

/** Icons a marketing granularity usually wants, shown before any search. */
const SUGGESTED = ["globe", "flag", "map-pin", "target", "tag", "store", "shopping-cart", "users", "layers", "megaphone", "package", "image", "calendar", "briefcase", "building-2", "plug", "filter", "gem", "rocket", "trophy", "zap", "sparkles", "tv", "smartphone", "truck", "badge-percent", "radio", "search", "heart", "star"];
const MAX = 60;

/**
 * The icon library (spec §18.5 IconPicker, plan 0.6): search Lucide's ~1,600 icons by name, pick
 * one (a radio group; arrow keys move), or upload an SVG (sanitized by the API, ≤ 50 KB).
 */
export function IconPicker({ ws, value, onChange }: { ws: string; value: string; onChange: (icon: string) => void }): ReactElement {
  const [q, setQ] = useState("");
  const id = useId();
  const term = q.trim().toLowerCase().replace(/\s+/g, "-");
  const matches = term ? iconNames.filter((n) => n.includes(term)).slice(0, MAX) : SUGGESTED;
  const current = value.startsWith("lucide:") ? value.slice("lucide:".length) : null;
  const shown = current && !matches.includes(current as never) ? [current, ...matches] : matches;
  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > 50_000) throw new Error(t("registry.icon.tooBig"));
      const svg = await file.text();
      return z.object({ icon: z.string() }).parse(await unwrap(api.POST("/api/v1/assets", { params: { header: { "X-Workspace-Id": ws } }, body: { contentType: "image/svg+xml", svg } as never })));
    },
    onSuccess: (r) => onChange(r.icon),
  });
  const move = (dir: number, from: number) => {
    const next = shown[(from + dir + shown.length) % shown.length];
    if (next) {
      onChange(`lucide:${next}`);
      document.getElementById(`${id}-${next}`)?.focus();
    }
  };
  return (
    <div className="flex flex-col gap-2" data-testid="icon-picker">
      <div className="flex items-center gap-2">
        <span className="inline-flex size-9 items-center justify-center rounded-lg border border-border bg-surface" aria-hidden>
          <DimensionIcon ws={ws} icon={value} className="size-5" />
        </span>
        <input type="search" className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-card px-2 text-sm outline-none focus:border-ring" placeholder={t("registry.icon.search")} aria-label={t("registry.icon.search")} value={q} onChange={(e) => setQ(e.target.value)} data-testid="icon-search" />
        <label className="inline-flex h-9 cursor-pointer items-center gap-1 rounded-lg border border-input bg-card px-3 text-sm hover:bg-accent">
          <Upload className="size-4" aria-hidden />
          {t("registry.icon.upload")}
          <input type="file" accept="image/svg+xml,.svg" className="sr-only" onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} data-testid="icon-upload" />
        </label>
      </div>
      <div role="radiogroup" aria-label={t("registry.icon.library")} className="grid max-h-48 grid-cols-10 gap-1 overflow-y-auto rounded-lg border border-border p-1.5">
        {shown.map((name, i) => {
          const selected = current === name;
          return (
            <button
              key={name}
              id={`${id}-${name}`}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={name.replace(/-/g, " ")}
              title={name}
              tabIndex={selected || (current === null && i === 0) ? 0 : -1}
              className={cn("inline-flex aspect-square items-center justify-center rounded-md hover:bg-accent", selected ? "bg-primary text-primary-foreground hover:bg-primary" : "")}
              onClick={() => onChange(`lucide:${name}`)}
              onKeyDown={(e) => {
                const step = { ArrowRight: 1, ArrowDown: 10, ArrowLeft: -1, ArrowUp: -10 }[e.key];
                if (step !== undefined) {
                  e.preventDefault();
                  move(step, i);
                }
              }}
              data-testid="icon-option"
              data-icon={name}
            >
              <DimensionIcon ws={ws} icon={`lucide:${name}`} />
            </button>
          );
        })}
        {shown.length === 0 ? <p className="col-span-10 p-2 text-xs text-muted-foreground">{t("registry.icon.none")}</p> : null}
      </div>
      {upload.error ? <p role="alert" className="text-xs text-destructive">{upload.error.message}</p> : null}
    </div>
  );
}
