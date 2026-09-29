import { BudgetImportPreview } from "@budget/domain";
import { formatChange, formatMoney } from "@budget/grid";
import { Button, Chip, FormField, Input, Modal, Select } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Download, TriangleAlert, Upload, X } from "lucide-react";
import { useState, type ReactElement } from "react";
import { z } from "zod";
import { api, unwrap } from "../../lib/api.js";
import { templatesQuery } from "../../lib/queries.js";

type Preview = z.infer<typeof BudgetImportPreview>;
const SHOWN = 200;

/**
 * Import budgets from a CSV (docs/DATA_PLAN.md §3, D-009): download this workspace's template, fill
 * it, pick it; the report says line by line what would be created, changed or refused, which parents
 * the hierarchy adds, and what would go over budget. Commit writes drafts under one approval.
 */
export function BudgetImportDialog({ ws, templateId: initialTemplate, onDone, onClose }: { ws: string; templateId?: string | undefined; onDone: (text: string, requestId: string | null) => void; onClose: () => void }): ReactElement {
  const { data: templates = [] } = useQuery(templatesQuery(ws));
  const [templateId, setTemplateId] = useState<string>(initialTemplate ?? "");
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [rationale, setRationale] = useState("");
  const chosen = templateId || templates.find((x) => x.isDefault)?.id || "";

  const download = useMutation({
    mutationFn: async () => {
      const text = (await unwrap(api.GET("/api/v1/workspaces/{ws}/budget-import/template", { params: { path: { ws }, query: (chosen ? { templateId: chosen } : {}) as never }, parseAs: "text" }))) as unknown as string;
      const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "budget-import.csv";
      a.click();
      URL.revokeObjectURL(url);
    },
  });
  const preview = useMutation({
    mutationFn: async (text: string): Promise<Preview> => BudgetImportPreview.parse(await unwrap(api.POST("/api/v1/workspaces/{ws}/budget-import/preview", { params: { path: { ws } }, body: { csv: text, ...(chosen ? { templateId: chosen } : {}) } as never }))),
  });
  const commit = useMutation({
    mutationFn: async () => {
      if (!preview.data) throw new Error("no preview");
      return z
        .object({ requestId: z.string().nullable(), autoApproved: z.boolean(), created: z.number(), parents: z.number(), changed: z.number() })
        .passthrough()
        .parse(await unwrap(api.POST("/api/v1/workspaces/{ws}/budget-import/commit", { params: { path: { ws } }, body: { previewId: preview.data.previewId, rationale: rationale.trim() } as never })));
    },
    onSuccess: (r) => onDone(t(r.autoApproved ? "import.done.applied" : "import.done.request", { created: r.created, parents: r.parents, changed: r.changed }), r.requestId),
  });
  const pick = async (f: File) => {
    const text = await f.text();
    setCsv(text);
    setFileName(f.name);
    preview.mutate(text);
  };
  const p = preview.data;
  const why = !p ? t("import.needFile") : p.blocked ?? (rationale.trim().length < 3 ? t("import.needReason") : commit.isPending ? t("shell.loading") : null);
  const lines = p ? [...p.lines.filter((l) => l.status === "error"), ...p.lines.filter((l) => l.status !== "error")].slice(0, SHOWN) : [];
  const tone = (s: string) => (s === "new" ? "info" : s === "change" ? "warning" : s === "error" ? "danger" : "neutral");

  return (
    <Modal onClose={onClose} labelledBy="import-title" testId="import-dialog">
      <div className="flex max-h-[88vh] w-full max-w-4xl flex-col gap-4 overflow-y-auto rounded-xl border border-border bg-card p-6 shadow-lg">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 id="import-title" className="text-lg font-semibold tracking-[-0.015em]">{t("import.title")}</h2>
            <p className="text-sm text-muted-foreground">{t("import.help")}</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label={t("drawer.close")}>
            <X className="size-4" aria-hidden />
          </Button>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <FormField label={t("import.hierarchy")} className="min-w-56">
            {(ids) => (
              <Select {...ids} value={chosen} onChange={(e) => (setTemplateId(e.target.value), csv && preview.mutate(csv))} data-testid="import-hierarchy">
                <option value="">{t("import.noHierarchy")}</option>
                {templates.map((x) => (
                  <option key={x.id} value={x.id}>{x.name}</option>
                ))}
              </Select>
            )}
          </FormField>
          <Button variant="outline" onClick={() => download.mutate()} data-testid="import-template">
            <Download className="size-4" aria-hidden />
            {t("import.downloadTemplate")}
          </Button>
          <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-3 text-sm font-medium hover:bg-accent">
            <Upload className="size-4" aria-hidden />
            {fileName || t("import.pickFile")}
            <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => e.target.files?.[0] && void pick(e.target.files[0])} data-testid="import-file" />
          </label>
        </div>
        {preview.isPending ? <p className="text-sm text-muted-foreground">{t("shell.loading")}</p> : null}
        {preview.error ? <p role="alert" className="text-sm text-destructive" data-testid="import-error">{preview.error.message}</p> : null}
        {p ? (
          <div className="flex flex-col gap-3" data-testid="import-report" data-new={p.counts.new} data-change={p.counts.change} data-same={p.counts.same} data-error={p.counts.error} data-parents={p.counts.parents}>
            <div className="flex flex-wrap gap-2 text-sm">
              <Chip tone="info">{t("import.count.new", { count: p.counts.new })}</Chip>
              <Chip tone="warning">{t("import.count.change", { count: p.counts.change })}</Chip>
              <Chip>{t("import.count.same", { count: p.counts.same })}</Chip>
              <Chip>{t("import.count.parents", { count: p.counts.parents })}</Chip>
              {p.counts.error ? <Chip tone="danger">{t("import.count.error", { count: p.counts.error })}</Chip> : null}
              <span className="tabular ml-auto text-muted-foreground">
                {t("import.totals", { new: formatMoney(p.totals.new, p.currency), change: formatChange(p.totals.change, p.currency) })}
              </span>
            </div>
            {p.unknownColumns.length ? <p className="text-xs text-muted-foreground">{t("import.unknownColumns", { columns: p.unknownColumns.join(", ") })}</p> : null}
            {p.overCap.length ? (
              <ul className="flex flex-col gap-0.5 text-sm text-destructive" data-testid="import-overcap">
                {p.overCap.map((o) => (
                  <li key={o.envelopeId} className="flex items-center gap-1.5">
                    <TriangleAlert className="size-4 shrink-0" aria-hidden />
                    {t("import.overCap", { name: o.name, approved: formatMoney(o.approved, p.currency), after: formatMoney(o.childrenAfter, p.currency) })}
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="max-h-80 overflow-auto rounded-lg border border-border">
              <table className="w-full text-sm" data-testid="import-lines">
                <thead className="sticky top-0 bg-surface text-left text-muted-foreground">
                  <tr>
                    <th className="px-3 py-1.5 font-medium">{t("import.col.line")}</th>
                    <th className="px-3 py-1.5 font-medium">{t("import.col.status")}</th>
                    <th className="px-3 py-1.5 font-medium">{t("import.col.budget")}</th>
                    <th className="px-3 py-1.5 text-right font-medium">{t("import.col.amount")}</th>
                    <th className="px-3 py-1.5 font-medium">{t("import.col.under")}</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.line} className="border-t border-border align-top" data-testid="import-line" data-line={l.line} data-status={l.status}>
                      <td className="tabular px-3 py-1.5 text-muted-foreground">{l.line}</td>
                      <td className="px-3 py-1.5"><Chip tone={tone(l.status)}>{t(`import.status.${l.status}` as "import.status.new")}</Chip></td>
                      <td className="px-3 py-1.5">
                        <span className="font-medium">{l.name}</span>
                        {l.problems.map((x, i) => (
                          <span key={i} className="block text-xs text-destructive" data-testid="import-problem">
                            {x.column ? `${x.column}: ` : ""}
                            {x.message}
                            {x.suggestion ? ` ${t("import.didYouMean", { value: x.suggestion })}` : ""}
                          </span>
                        ))}
                      </td>
                      <td className="tabular px-3 py-1.5 text-right">
                        {l.amount && l.currency ? formatMoney(l.amount, l.currency) : "—"}
                        {l.status === "change" && l.currentAmount && l.currency ? <span className="block text-xs text-muted-foreground">{t("import.was", { amount: formatMoney(l.currentAmount, l.currency) })}</span> : null}
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">{l.parent?.name ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {p.lines.length > SHOWN ? <p className="text-xs text-muted-foreground">{t("import.moreLines", { shown: SHOWN, total: p.lines.length })}</p> : null}
            {p.parents.length ? (
              <details className="text-sm" data-testid="import-parents">
                <summary className="cursor-pointer font-medium">{t("import.parentsTitle", { count: p.parents.length })}</summary>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {p.parents.map((x) => (
                    <li key={`${x.name}|${x.startDate}`} className="flex gap-2">
                      <span className="min-w-0 flex-1 truncate">{x.name}</span>
                      <span className="text-xs text-muted-foreground">{x.parent?.name ? t("import.under", { name: x.parent.name }) : t("import.topLevel")}</span>
                      <span className="tabular">{formatMoney(x.amount, x.currency)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {p.blocked ? <p className="text-sm font-medium text-destructive" data-testid="import-blocked">{p.blocked}</p> : null}
          </div>
        ) : null}
        <FormField label={t("import.reason")}>{(ids) => <Input {...ids} value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder={t("import.reasonHint")} data-testid="import-reason" />}</FormField>
        {commit.error ? <p role="alert" className="text-sm text-destructive">{commit.error.message}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{t("threads.cancel")}</Button>
          {why ? (
            <Button disabled reason={why} data-testid="import-commit">{t("import.commit")}</Button>
          ) : (
            <Button onClick={() => commit.mutate()} data-testid="import-commit">{t("import.commit")}</Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
