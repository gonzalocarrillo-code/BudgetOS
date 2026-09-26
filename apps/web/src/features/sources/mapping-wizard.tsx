import type { ColumnMapping } from "@budget/domain";
import { Button, cn } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, FileUp, Sparkles } from "lucide-react";
import { useState, type ReactElement } from "react";
import { z } from "zod";
import { ApiError, api, unwrap } from "../../lib/api.js";
import { registryQuery } from "../../lib/queries.js";
import { guessMapping, mappingProblems, parseCsvSample, type Sample } from "./mapping.js";

type Kind = "spend" | "kpi" | "spend+kpi" | "projection";
export interface Mapping {
  kind: Kind;
  columns: Record<string, ColumnMapping>;
}

/** What a column maps to, as one select value: `role:amount`, `dim:country`, … */
const choiceOf = (c: ColumnMapping | undefined): string => (!c ? "role:ignore" : "dimension" in c ? `dim:${c.dimension}` : `role:${c.role}`);
const ROLES = ["period_date", "amount", "currency", "kpi", "projection", "formula_version", "horizon_end", "ignore"] as const;

/**
 * MappingWizard (spec §18.5, §14): 1) pick a CSV (its header and first 20 rows are read here);
 * 2) say what each column is — matched by name first, or suggested by AI (@budget/ai) when it is
 * configured — checked live against the domain's SourceMapping rules; 3) name it and create:
 * the file is uploaded, the source saved, and its first run queued. With `source` it edits an
 * existing source's mapping (no file: the columns are the mapped ones).
 */
export function MappingWizard({ ws, source, onDone, onCancel }: { ws: string; source?: { id: string; name: string; mapping: Mapping } | undefined; onDone: (sourceId: string) => void; onCancel: () => void }): ReactElement {
  const { data: dims = [] } = useQuery(registryQuery(ws));
  const [step, setStep] = useState<1 | 2 | 3>(source ? 2 : 1);
  const [file, setFile] = useState<File | null>(null);
  const [sample, setSample] = useState<Sample | null>(source ? { header: Object.keys(source.mapping.columns), rows: [] } : null);
  const [mapping, setMapping] = useState<Mapping | null>(source?.mapping ?? null);
  const [name, setName] = useState(source?.name ?? "");
  const [schedule, setSchedule] = useState("");
  const [runNow, setRunNow] = useState(true);
  const [aiNote, setAiNote] = useState<string | null>(null);

  const read = async (f: File) => {
    const s = parseCsvSample(await f.text());
    setFile(f);
    setSample(s);
    setMapping(guessMapping(s, dims));
    setName(f.name.replace(/\.csv$/i, ""));
    setAiNote(null);
    setStep(2);
  };
  const suggest = useMutation({
    mutationFn: async () => {
      if (!sample) throw new Error("no sample");
      const rows = sample.rows.map((r) => r.map((v) => (v === "" ? null : v)));
      return z.object({ mapping: z.object({ kind: z.string(), columns: z.record(z.string(), z.record(z.string(), z.unknown())) }), model: z.string() }).parse(await unwrap(api.POST("/api/v1/workspaces/{ws}/mapping-suggestions", { params: { path: { ws } }, body: { header: sample.header, rows } as never })));
    },
    onSuccess: (r) => {
      setMapping({ kind: r.mapping.kind as Kind, columns: r.mapping.columns as Record<string, ColumnMapping> });
      setAiNote(t("sources.ai.applied", { model: r.model }));
    },
    onError: (e) => setAiNote(e instanceof ApiError && e.status === 503 ? t("sources.ai.unavailable") : e.message),
  });
  const create = useMutation({
    mutationFn: async () => {
      if (!mapping) throw new Error("no mapping");
      const header = { "X-Workspace-Id": ws };
      if (source) {
        await unwrap(api.PATCH("/api/v1/sources/{id}", { params: { path: { id: source.id }, header }, body: { mapping } as never }));
        return source.id;
      }
      if (!file) throw new Error("no file");
      const upload = z.object({ uri: z.string(), uploadUrl: z.string(), method: z.enum(["PUT", "POST"]).default("PUT"), contentType: z.string() }).parse(await unwrap(api.POST("/api/v1/uploads", { params: { header }, body: { filename: file.name.replace(/[^\w.\- ]/g, "_") } as never })));
      const res = await fetch(upload.uploadUrl, { method: upload.method, headers: { "content-type": upload.contentType }, body: file });
      if (!res.ok) throw new Error(t("sources.uploadFailed", { status: res.status }));
      const created = z.object({ id: z.string() }).parse(await unwrap(api.POST("/api/v1/workspaces/{ws}/sources", { params: { path: { ws } }, body: { name: name.trim(), config: { kind: "csv", uri: upload.uri }, mapping, ...(schedule.trim() ? { schedule: schedule.trim() } : {}) } as never })));
      if (runNow) await unwrap(api.POST("/api/v1/sources/{id}/run", { params: { path: { id: created.id }, header }, body: {} as never }));
      return created.id;
    },
    onSuccess: onDone,
  });

  const problems = mapping ? mappingProblems(mapping) : [t("sources.pickFile")];
  const setColumn = (col: string, c: ColumnMapping) => mapping && setMapping({ ...mapping, columns: { ...mapping.columns, [col]: c } });
  const onChoice = (col: string, v: string) => {
    const [kind, key] = v.split(":") as [string, string];
    if (kind === "dim") return setColumn(col, { dimension: key });
    if (key === "period_date") return setColumn(col, { role: "period_date", format: "yyyy-MM-dd" });
    if (key === "kpi") return setColumn(col, { role: "kpi", metric: col.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+/, "") || "metric" });
    if (key === "projection") return setColumn(col, { role: "projection", metric: "spend" });
    return setColumn(col, { role: key } as ColumnMapping);
  };
  const field = "h-8 rounded-md border border-input bg-card px-2 text-sm outline-none focus:border-ring";
  const nextWhy = problems[0] ?? null;
  const saveWhy = nextWhy ?? (create.isPending ? t("shell.loading") : null);
  const createWhy = !name.trim() ? t("sources.needName") : schedule.trim() && !/^(\S+\s){4}\S+$/.test(schedule.trim()) ? t("sources.badCron") : create.isPending ? t("shell.loading") : null;

  return (
    <div className="flex flex-col gap-4" data-testid="mapping-wizard" data-step={step}>
      <ol className="flex flex-wrap gap-2 text-sm" aria-label={t("sources.steps")}>
        {(["sources.step.file", "sources.step.columns", "sources.step.save"] as const).map((k, i) => (
          <li key={k} aria-current={step === i + 1 ? "step" : undefined} className={cn("inline-flex items-center gap-1.5 rounded-full px-3 py-1", step === i + 1 ? "bg-primary text-primary-foreground" : step > i + 1 ? "bg-secondary text-secondary-foreground" : "bg-surface text-muted-foreground")}>
            {step > i + 1 ? <Check className="size-3.5" aria-hidden /> : <span className="tabular">{i + 1}</span>}
            {t(k)}
          </li>
        ))}
      </ol>

      {step === 1 ? (
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-border px-6 py-10 text-center hover:bg-accent/40">
          <FileUp className="size-8 text-muted-foreground" aria-hidden />
          <span className="text-sm font-medium">{t("sources.chooseCsv")}</span>
          <span className="text-xs text-muted-foreground">{t("sources.chooseCsvHelp")}</span>
          <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => e.target.files?.[0] && void read(e.target.files[0])} data-testid="wizard-file" />
        </label>
      ) : null}

      {step === 2 && sample && mapping ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm">
              {t("sources.kind")}
              <select className={field} value={mapping.kind} onChange={(e) => setMapping({ ...mapping, kind: e.target.value as Kind })} data-testid="wizard-kind">
                {(["spend", "kpi", "spend+kpi", "projection"] as const).map((k) => (
                  <option key={k} value={k}>
                    {t(`sources.kind.${k.replace("+", "_")}` as MessageKey)}
                  </option>
                ))}
              </select>
            </label>
            {sample.rows.length ? (
              <Button variant="outline" size="sm" className="ml-auto" onClick={() => suggest.mutate()} data-testid="wizard-ai">
                <Sparkles className="size-4" aria-hidden />
                {suggest.isPending ? t("shell.loading") : t("sources.ai.suggest")}
              </Button>
            ) : null}
          </div>
          {aiNote ? <p className="text-xs text-muted-foreground" role="status" data-testid="wizard-ai-note">{aiNote}</p> : null}
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm" data-testid="wizard-columns">
              <thead className="bg-surface text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t("sources.col.column")}</th>
                  <th className="px-3 py-2 font-medium">{t("sources.col.sample")}</th>
                  <th className="px-3 py-2 font-medium">{t("sources.col.mapsTo")}</th>
                  <th className="px-3 py-2 font-medium">{t("sources.col.details")}</th>
                </tr>
              </thead>
              <tbody>
                {sample.header.map((col, i) => {
                  const c = mapping.columns[col];
                  return (
                    <tr key={col} className="border-t border-border" data-testid="wizard-column" data-column={col}>
                      <td className="px-3 py-2 font-medium">{col}</td>
                      <td className="max-w-40 truncate px-3 py-2 text-xs text-muted-foreground">{sample.rows.slice(0, 3).map((r) => r[i] ?? "").join(" · ") || "—"}</td>
                      <td className="px-3 py-2">
                        <select className={field} value={choiceOf(c)} onChange={(e) => onChoice(col, e.target.value)} aria-label={t("sources.mapsToFor", { column: col })} data-testid="wizard-choice">
                          <optgroup label={t("sources.roles")}>
                            {ROLES.map((r) => (
                              <option key={r} value={`role:${r}`}>
                                {t(`sources.role.${r}` as MessageKey)}
                              </option>
                            ))}
                          </optgroup>
                          <optgroup label={t("sources.dimensions")}>
                            {dims.filter((d) => d.isActive).map((d) => (
                              <option key={d.key} value={`dim:${d.key}`}>
                                {d.label}
                              </option>
                            ))}
                          </optgroup>
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <Details c={c} onChange={(n) => setColumn(col, n)} field={field} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {problems.length ? (
            <ul className="flex flex-col gap-0.5 text-sm text-destructive" role="alert" data-testid="wizard-problems">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-success" data-testid="wizard-ok">{t("sources.mappingOk")}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={source ? onCancel : () => setStep(1)}>
              {t(source ? "threads.cancel" : "sources.back")}
            </Button>
            {source ? (
              saveWhy ? (
                <Button disabled reason={saveWhy} data-testid="wizard-save">{t("sources.saveMapping")}</Button>
              ) : (
                <Button onClick={() => create.mutate()} data-testid="wizard-save">{t("sources.saveMapping")}</Button>
              )
            ) : nextWhy ? (
              <Button disabled reason={nextWhy} data-testid="wizard-next">{t("sources.next")}</Button>
            ) : (
              <Button onClick={() => setStep(3)} data-testid="wizard-next">{t("sources.next")}</Button>
            )}
          </div>
        </div>
      ) : null}

      {step === 3 ? (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t("sources.name")}
            <input className="h-9 rounded-lg border border-input bg-card px-2 text-sm outline-none focus:border-ring" value={name} onChange={(e) => setName(e.target.value)} data-testid="wizard-name" />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t("sources.schedule")}
            <input className="h-9 rounded-lg border border-input bg-card px-2 font-mono text-sm outline-none focus:border-ring" value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="0 6 * * *" />
            <span className="text-xs font-normal text-muted-foreground">{t("sources.scheduleHelp")}</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={runNow} onChange={(e) => setRunNow(e.target.checked)} />
            {t("sources.runNow")}
          </label>
          {create.error ? <p role="alert" className="text-sm text-destructive">{create.error.message}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setStep(2)}>{t("sources.back")}</Button>
            {createWhy ? (
              <Button disabled reason={createWhy} data-testid="wizard-create">{t("sources.create")}</Button>
            ) : (
              <Button onClick={() => create.mutate()} data-testid="wizard-create">{t("sources.create")}</Button>
            )}
          </div>
        </div>
      ) : null}
      {step !== 3 && create.error ? <p role="alert" className="text-sm text-destructive">{create.error.message}</p> : null}
    </div>
  );
}

/** A column's extra settings: the date format, the amount's currency, the KPI's metric, a dimension's transform. */
function Details({ c, onChange, field }: { c: ColumnMapping | undefined; onChange: (c: ColumnMapping) => void; field: string }): ReactElement | null {
  if (!c) return null;
  if ("dimension" in c)
    return (
      <select className={field} value={c.transform ?? ""} onChange={(e) => onChange({ dimension: c.dimension, ...(e.target.value ? { transform: e.target.value as "lower" } : {}) })} aria-label={t("sources.transform")}>
        <option value="">{t("sources.transform.none")}</option>
        <option value="lower">{t("sources.transform.lower")}</option>
        <option value="upper">{t("sources.transform.upper")}</option>
        <option value="trim">{t("sources.transform.trim")}</option>
      </select>
    );
  if (c.role === "period_date")
    return (
      <select className={field} value={c.format} onChange={(e) => onChange({ role: "period_date", format: e.target.value as "yyyy-MM-dd" })} aria-label={t("sources.dateFormat")}>
        {(["yyyy-MM-dd", "yyyy-MM", "dd/MM/yyyy", "MM/dd/yyyy"] as const).map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
    );
  if (c.role === "amount")
    return <input className={cn(field, "w-24 uppercase")} value={c.currency ?? ""} maxLength={3} placeholder={t("sources.currencyInline")} onChange={(e) => onChange({ role: "amount", ...(e.target.value ? { currency: e.target.value.toUpperCase() } : {}) })} aria-label={t("sources.currencyInline")} data-testid="wizard-currency" />;
  if (c.role === "kpi" || c.role === "projection") return <input className={cn(field, "w-36 font-mono")} value={c.metric} onChange={(e) => onChange({ ...c, metric: e.target.value })} aria-label={t("sources.metric")} />;
  return null;
}
