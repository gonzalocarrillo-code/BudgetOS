import type { NamingChip } from "@budget/domain";
import { Button, cn } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, GripVertical, X } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";
import { z } from "zod";
import { api, unwrap } from "../../lib/api.js";
import { registryQuery } from "../../lib/queries.js";
import { DimensionIcon } from "./dimension-icon.js";

export type Kind = "display" | "match_key";
export const NamingTemplate = z.object({ id: z.string().uuid(), kind: z.enum(["display", "match_key"]), chips: z.array(z.record(z.string(), z.unknown())), casing: z.string(), whitespace: z.string(), stripAccents: z.boolean(), version: z.number(), isActive: z.boolean() });
export type NamingTemplateRow = z.infer<typeof NamingTemplate>;

const SEPARATORS = ["_", "-", ":", "·", " ", "/", "|"] as const;
const PERIODS = ["yyyy", "yyyy-QQ", "yyyy-MM", "MMM yyyy", "fiscal"] as const;
const chipText = (c: NamingChip, labelOf: (key: string) => string) => (c.type === "dimension" ? labelOf(c.key) : c.type === "separator" ? (c.value === " " ? "␣" : c.value) : c.type === "text" ? `“${c.value}”` : c.format);

/** The request body settles 300 ms after the last change: each preview renders five envelopes on the server. */
function useSettled<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  const key = JSON.stringify(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [key, ms]); // keyed by the value's JSON
  return v;
}

/**
 * NamingTemplateBuilder (spec §24.4): chips from a palette — the registry's granularities with
 * their icons, separators, free text, period formats — reordered by drag or the arrow buttons,
 * with casing, whitespace and accent options and a live preview of five envelopes. Saving makes it
 * the active template of its kind (a new version when one exists); envelopes are renamed.
 */
export function NamingTemplateBuilder({ ws, kind, current, blocked, onSaved }: { ws: string; kind: Kind; current: NamingTemplateRow | null; blocked: string | null; onSaved: (r: { recomputed: number; queued: boolean }) => void }): ReactElement {
  const { data: dims = [] } = useQuery(registryQuery(ws));
  const [chips, setChips] = useState<NamingChip[]>((current?.chips as NamingChip[] | undefined) ?? []);
  const [casing, setCasing] = useState(current?.casing ?? (kind === "match_key" ? "lower" : "original"));
  const [whitespace, setWhitespace] = useState(current?.whitespace ?? (kind === "match_key" ? "underscore" : "keep"));
  const [stripAccents, setStripAccents] = useState(current?.stripAccents ?? kind === "match_key");
  const [text, setText] = useState("");
  const [drag, setDrag] = useState<number | null>(null);
  const labelOf = (key: string) => dims.find((d) => d.key === key)?.label ?? key;
  const template = { kind, chips, casing, whitespace, stripAccents };
  const settled = useSettled(template);
  const preview = useQuery({
    queryKey: ["naming-preview", ws, settled],
    queryFn: async () => z.object({ previews: z.array(z.object({ envelopeId: z.string(), name: z.string(), rendered: z.string() })) }).parse(await unwrap(api.POST("/api/v1/naming-templates/preview", { params: { header: { "X-Workspace-Id": ws } }, body: { template: settled } as never }))),
    enabled: settled.chips.length > 0 && blocked === null,
    placeholderData: keepPreviousData,
  });
  const save = useMutation({
    mutationFn: async () => {
      const r = current
        ? await unwrap(api.PATCH("/api/v1/naming-templates/{id}", { params: { path: { id: current.id }, header: { "X-Workspace-Id": ws } }, body: { chips, casing, whitespace, stripAccents, isActive: true } as never }))
        : await unwrap(api.POST("/api/v1/workspaces/{ws}/naming-templates", { params: { path: { ws } }, body: template as never }));
      return z.object({ recomputed: z.number(), queued: z.boolean() }).parse(r);
    },
    onSuccess: onSaved,
  });
  const add = (c: NamingChip) => setChips([...chips, c]);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= chips.length) return;
    const next = [...chips];
    const [c] = next.splice(from, 1);
    if (c) next.splice(to, 0, c);
    setChips(next);
  };
  const why = blocked ?? (chips.length === 0 ? t("naming.needChip") : save.isPending ? t("shell.loading") : null);
  const pill = "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs";

  return (
    <div className="flex flex-col gap-4" data-testid="naming-builder" data-kind={kind}>
      <p className="text-sm text-muted-foreground">{t(kind === "display" ? "naming.displayHelp" : "naming.matchKeyHelp")}</p>

      <div className="flex min-h-12 flex-wrap items-center gap-1.5 rounded-lg border border-border bg-surface p-2" aria-label={t("naming.chips")} role="list" data-testid="naming-chips">
        {chips.length === 0 ? <span className="px-1 text-sm text-muted-foreground">{t("naming.empty")}</span> : null}
        {chips.map((c, i) => (
          <span
            key={`${i}-${JSON.stringify(c)}`}
            role="listitem"
            draggable
            onDragStart={() => setDrag(i)}
            onDragEnd={() => setDrag(null)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => (e.preventDefault(), drag !== null && move(drag, i), setDrag(null))}
            className={cn(pill, "cursor-grab bg-card", c.type === "dimension" ? "border-primary/40" : "border-border", drag === i ? "opacity-50" : "")}
            data-testid="naming-chip"
          >
            <GripVertical className="size-3 text-muted-foreground" aria-hidden />
            {c.type === "dimension" ? <DimensionIcon ws={ws} icon={dims.find((d) => d.key === c.key)?.icon ?? "lucide:tag"} className="size-3.5" /> : null}
            <span className="font-medium">{chipText(c, labelOf)}</span>
            <button type="button" className="rounded p-0.5 hover:bg-accent" aria-label={t("naming.left", { chip: chipText(c, labelOf) })} onClick={() => move(i, i - 1)}>
              <ArrowLeft className="size-3" aria-hidden />
            </button>
            <button type="button" className="rounded p-0.5 hover:bg-accent" aria-label={t("naming.right", { chip: chipText(c, labelOf) })} onClick={() => move(i, i + 1)}>
              <ArrowRight className="size-3" aria-hidden />
            </button>
            <button type="button" className="rounded p-0.5 hover:bg-accent" aria-label={t("naming.remove", { chip: chipText(c, labelOf) })} onClick={() => setChips(chips.filter((_, j) => j !== i))} data-testid="naming-chip-remove">
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}
      </div>

      <div className="flex flex-col gap-2" data-testid="naming-palette">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("naming.dimensions")}>
          <span className="w-24 text-xs text-muted-foreground">{t("naming.dimensions")}</span>
          {dims.filter((d) => d.isActive).map((d) => (
            <button key={d.key} type="button" className={cn(pill, "border-border hover:bg-accent")} onClick={() => add({ type: "dimension", key: d.key })} data-testid="naming-add-dimension" data-key={d.key}>
              <DimensionIcon ws={ws} icon={d.icon} className="size-3.5" />
              {d.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("naming.separators")}>
          <span className="w-24 text-xs text-muted-foreground">{t("naming.separators")}</span>
          {SEPARATORS.map((s) => (
            <button key={s} type="button" className={cn(pill, "border-border font-mono hover:bg-accent")} onClick={() => add({ type: "separator", value: s })} aria-label={t("naming.addSeparator", { sep: s === " " ? t("naming.space") : s })} data-testid="naming-add-separator" data-value={s}>
              {s === " " ? "␣" : s}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="w-24 text-xs text-muted-foreground">{t("naming.text")}</span>
          <input className="h-7 w-32 rounded-md border border-input bg-card px-2 text-xs outline-none focus:border-ring" value={text} onChange={(e) => setText(e.target.value.slice(0, 40))} aria-label={t("naming.text")} data-testid="naming-text" />
          <Button size="sm" variant="outline" className="h-7" onClick={() => text.trim() && (add({ type: "text", value: text.trim() }), setText(""))} data-testid="naming-add-text">
            {t("naming.add")}
          </Button>
          <span className="ml-3 text-xs text-muted-foreground">{t("naming.period")}</span>
          {PERIODS.map((f) => (
            <button key={f} type="button" className={cn(pill, "border-border hover:bg-accent")} onClick={() => add({ type: "period", format: f })} data-testid="naming-add-period" data-format={f}>
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          {t("naming.casing")}
          <select className="h-8 rounded-md border border-input bg-card px-2 text-sm" value={casing} onChange={(e) => setCasing(e.target.value)} data-testid="naming-casing">
            {(["original", "lower", "upper"] as const).map((c) => (
              <option key={c} value={c}>
                {t(`naming.casing.${c}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          {t("naming.whitespace")}
          <select className="h-8 rounded-md border border-input bg-card px-2 text-sm" value={whitespace} onChange={(e) => setWhitespace(e.target.value)} data-testid="naming-whitespace">
            {(["keep", "underscore", "dash", "remove"] as const).map((w) => (
              <option key={w} value={w}>
                {t(`naming.whitespace.${w}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={stripAccents} onChange={(e) => setStripAccents(e.target.checked)} />
          {t("naming.stripAccents")}
        </label>
      </div>

      <div className="rounded-lg border border-border" data-testid="naming-preview" aria-live="polite">
        <div className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">{t("naming.preview")}</div>
        {chips.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">{t("naming.previewEmpty")}</p>
        ) : (
          <table className={cn("w-full text-sm", preview.isFetching ? "opacity-60" : "")}>
            <tbody>
              {(preview.data?.previews ?? []).map((p) => (
                <tr key={p.envelopeId} className="border-t border-border first:border-t-0" data-testid="naming-preview-row">
                  <td className="w-1/2 truncate px-3 py-1.5 text-muted-foreground">{p.name}</td>
                  <td className="px-3 py-1.5 font-medium" data-testid="naming-preview-rendered">
                    {p.rendered || <span className="text-muted-foreground">{t("naming.renderedEmpty")}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {preview.error ? <p role="alert" className="px-3 py-2 text-xs text-destructive">{preview.error.message}</p> : null}
      </div>

      {save.error ? <p role="alert" className="text-sm text-destructive">{save.error.message}</p> : null}
      <div className="flex items-center justify-end gap-2">
        {current ? <span className="mr-auto text-xs text-muted-foreground">{t("naming.version", { n: current.version, state: t(current.isActive ? "naming.active" : "naming.inactive") })}</span> : null}
        {why ? (
          <Button disabled reason={why} data-testid="naming-save">
            {t("naming.save")}
          </Button>
        ) : (
          <Button onClick={() => save.mutate()} data-testid="naming-save">
            {t("naming.save")}
          </Button>
        )}
      </div>
    </div>
  );
}
