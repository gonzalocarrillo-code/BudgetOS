import {
  CAMPAIGN_DIMENSION,
  DictionaryWriteResponse,
  FillDictionaryAiResponse,
  NamingDictionariesResponse,
  NamingDictionaryView,
  dictionaryToCsv,
  parseDictionaryCsv,
  parseDictionaryPaste,
  type DictionaryEntryInput,
  type DictionaryEntryView,
  type ParsedEntries,
} from "@budget/domain";
import { Button, Input, Select, Textarea } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactElement } from "react";
import { api, unwrap } from "../../lib/api.js";
import type { Dimension } from "../../lib/queries.js";
import { dictionaryName } from "./campaign-naming.js";

/**
 * EX-7 (ADR-0093): Registry › Campaign names › Dictionaries — where the dictionaries live. Pick a
 * granularity; its entries (code as written in names → meaning → registry value, and where each
 * came from) are searchable (server-side), added, edited and deleted inline, pasted in bulk
 * (code<TAB>meaning), imported and exported as CSV, reset to the built-in list, and filled with AI
 * as a reviewable table where only checked rows are written. Synced entries (EX-8) are read-only.
 */

export const dictionariesQuery = (ws: string) =>
  queryOptions({
    queryKey: ["naming-dictionaries", ws],
    queryFn: async () => NamingDictionariesResponse.parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/naming-dictionaries", { params: { path: { ws } } }))),
  });

/** Rows shown at once; search narrows the rest. */
const PAGE = 500;
const EXPORT_LIMIT = 5000;

const dictionaryQuery = (ws: string, dimension: string, q: string, limit = PAGE) =>
  queryOptions({
    queryKey: ["naming-dictionary", ws, dimension, q, limit],
    queryFn: async () => NamingDictionaryView.parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/naming-dictionaries/{dimension}", { params: { path: { ws, dimension }, query: { ...(q ? { q } : {}), limit } } }))),
  });

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const sourceText = (e: Pick<DictionaryEntryView, "source" | "legacy">) => (e.legacy ? t("namingDict.source.legacy") : t(`namingDict.source.${e.source}` as MessageKey));

export function NamingDictionaries({ ws, dims, canManage, dimension, q, onDimension, onQ }: { ws: string; dims: Dimension[]; canManage: boolean; dimension: string | undefined; q: string; onDimension: (key: string) => void; onQ: (q: string) => void }): ReactElement {
  const client = useQueryClient();
  const { data: summary } = useQuery(dictionariesQuery(ws));
  const granularities = dims.filter((d) => d.isActive && d.key !== CAMPAIGN_DIMENSION);
  const key = dimension && granularities.some((d) => d.key === dimension) ? dimension : granularities[0]?.key;
  const meta = summary?.dictionaries.find((d) => d.dimension === key) ?? null;
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = () => Promise.all(["naming-dictionaries", "naming-dictionary", "naming-preview", "naming-convention", "registry", "match-coverage"].map((k) => client.invalidateQueries({ queryKey: [k, ws] })));
  const done = async (res: DictionaryWriteResponse) => {
    await refresh();
    const n = res.rematch ? res.rematch.spend + res.rematch.kpi + res.rematch.projection : 0;
    setNotice(t("namingDict.written", { n }));
  };
  if (!key) return <p className="text-sm text-muted-foreground" data-testid="dict-none">{t("namingDict.noGranularities")}</p>;
  return (
    <div className="flex flex-col gap-3" data-testid="naming-dictionaries" data-tour="registry-dictionaries">
      <p className="text-sm text-muted-foreground">{t("namingDict.help")}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("namingDict.granularity")}
          <Select value={key} onChange={(e) => (setNotice(null), onDimension(e.target.value))} data-testid="dict-picker" data-tour="dict-picker">
            {granularities.map((d) => {
              const s = summary?.dictionaries.find((x) => x.dimension === d.key);
              return (
                <option key={d.key} value={d.key}>
                  {s ? t("namingDict.pickerOption", { label: d.label, n: s.entries }) : d.label}
                </option>
              );
            })}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("namingDict.search")}
          <Input size="sm" className="w-56" type="search" value={q} onChange={(e) => onQ(e.target.value)} placeholder={t("namingDict.searchPlaceholder")} data-testid="dict-search" />
        </label>
      </div>
      {notice ? <p role="status" className="text-sm" data-testid="dict-notice">{notice}</p> : null}
      <Editor key={key} ws={ws} dimension={key} label={granularities.find((d) => d.key === key)?.label ?? key} dim={granularities.find((d) => d.key === key) ?? null} q={q} canManage={canManage} aiAvailable={summary?.aiAvailable ?? false} position={meta?.position ?? null} onDone={done} />
    </div>
  );
}

function Editor({ ws, dimension, label, dim, q, canManage, aiAvailable, position, onDone }: { ws: string; dimension: string; label: string; dim: Dimension | null; q: string; canManage: boolean; aiAvailable: boolean; position: number | null; onDone: (res: DictionaryWriteResponse) => Promise<void> }): ReactElement {
  const client = useQueryClient();
  const { data, error } = useQuery(dictionaryQuery(ws, dimension, q));
  const path = { ws, dimension };
  const blocked = canManage ? null : t("campaignNaming.noManage");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [imported, setImported] = useState<ParsedEntries | null>(null);
  const bulk = useMutation({
    mutationFn: async (b: { entries: DictionaryEntryInput[]; source: "user" | "ai" }) => DictionaryWriteResponse.parse(await unwrap(api.POST("/api/v1/workspaces/{ws}/naming-dictionaries/{dimension}/bulk", { params: { path }, body: b as never }))),
    onSuccess: async (res) => (setPasteOpen(false), setImported(null), await onDone(res)),
  });
  const reset = useMutation({
    mutationFn: async () => DictionaryWriteResponse.parse(await unwrap(api.POST("/api/v1/workspaces/{ws}/naming-dictionaries/{dimension}/reset", { params: { path } }))),
    onSuccess: async (res) => (setConfirmReset(false), await onDone(res)),
  });
  const ai = useMutation({
    mutationFn: async () => FillDictionaryAiResponse.parse(await unwrap(api.POST("/api/v1/workspaces/{ws}/naming-dictionaries/{dimension}/ai-fill", { params: { path }, body: { position } as never }))),
  });
  const exporter = useMutation({
    mutationFn: async () => {
      const all = await client.fetchQuery(dictionaryQuery(ws, dimension, "", EXPORT_LIMIT));
      download(`${dimension}-dictionary.csv`, dictionaryToCsv(all.entries));
    },
  });
  const seedable = data ? data.builtinCount !== null && data.kind !== "quarter" && data.kind !== "year" : false;
  const resetWhy = blocked ?? (!seedable ? t("namingDict.noBuiltin") : reset.isPending ? t("campaignNaming.saving") : null);
  const aiWhy = blocked ?? (!aiAvailable ? t("campaignNaming.aiOff") : position === null ? t("namingDict.aiNoPosition") : ai.isPending ? t("campaignNaming.suggesting") : null);
  const importFile = async (file: File | undefined) => {
    if (!file) return;
    const parsed = parseDictionaryCsv(await file.text());
    setImported(parsed);
    if (parsed.entries.length > 0 && blocked === null) bulk.mutate({ entries: parsed.entries, source: "user" });
  };

  return (
    <div className="flex flex-col gap-3">
      {data ? (
        <p className="text-xs text-muted-foreground" data-testid="dict-info">
          {[
            dictionaryName(data.kind),
            data.kind === null ? null : data.seeded ? t("namingDict.seeded") : seedable ? t("namingDict.notSeeded", { n: data.builtinCount ?? 0 }) : null,
            data.position !== null ? t("campaignNaming.positionLine", { n: data.position }) : t("namingDict.noPosition"),
            data.syncSourceId ? t("namingDict.syncedDictionary") : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {blocked ? (
          <Button size="sm" variant="outline" disabled reason={blocked} data-testid="dict-paste-toggle">
            {t("namingDict.paste")}
          </Button>
        ) : (
          <Button size="sm" variant="outline" aria-expanded={pasteOpen} onClick={() => setPasteOpen(!pasteOpen)} data-testid="dict-paste-toggle" data-tour="dict-paste">
            {t("namingDict.paste")}
          </Button>
        )}
        <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          {t("namingDict.import")}
          <input type="file" accept=".csv,text/csv" disabled={blocked !== null} title={blocked ?? undefined} className="text-xs" onChange={(e) => void importFile(e.target.files?.[0])} data-testid="dict-import" aria-label={t("namingDict.import")} />
        </label>
        <Button size="sm" variant="ghost" onClick={() => exporter.mutate()} data-testid="dict-export">
          {t("namingDict.export")}
        </Button>
        {aiWhy ? (
          <Button size="sm" variant="ghost" disabled reason={aiWhy} data-testid="dict-ai">
            {t("namingDict.aiFill")}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => ai.mutate()} data-testid="dict-ai" data-tour="dict-ai">
            {t("namingDict.aiFill")}
          </Button>
        )}
        {resetWhy ? (
          <Button size="sm" variant="ghost" className="ml-auto" disabled reason={resetWhy} data-testid="dict-reset">
            {t("namingDict.reset")}
          </Button>
        ) : confirmReset ? (
          <span className="ml-auto inline-flex items-center gap-2 text-xs">
            {t("namingDict.resetWarning")}
            <Button size="sm" variant="destructive" onClick={() => reset.mutate()} data-testid="dict-reset-confirm">
              {t("namingDict.resetConfirm")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>
              {t("namingDict.cancel")}
            </Button>
          </span>
        ) : (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setConfirmReset(true)} data-testid="dict-reset">
            {t("namingDict.reset")}
          </Button>
        )}
      </div>
      {imported && imported.errors.length > 0 ? <p role="alert" className="text-xs text-destructive" data-testid="dict-import-errors">{t("namingDict.importErrors", { lines: imported.errors.slice(0, 20).join(", ") })}</p> : null}
      {[bulk.error, reset.error, ai.error, exporter.error, error].map((e, i) => (e ? <p key={i} role="alert" className="text-xs text-destructive">{e.message}</p> : null))}
      {pasteOpen ? <Paste pending={bulk.isPending} onSave={(entries) => bulk.mutate({ entries, source: "user" })} /> : null}
      {ai.data ? <AiReview res={ai.data} pending={bulk.isPending} onAccept={(entries) => bulk.mutate({ entries, source: "ai" }, { onSuccess: () => ai.reset() })} onDismiss={() => ai.reset()} /> : null}
      <AddRow ws={ws} dimension={dimension} dim={dim} blocked={blocked} onDone={onDone} />
      {data && data.entries.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="dict-empty">
          {q ? t("namingDict.emptySearch", { q }) : data.kind === null ? t("namingDict.emptyNoBuiltin") : t("namingDict.emptyBuiltin")}
        </p>
      ) : null}
      {data && data.entries.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs" aria-label={t("namingDict.tableLabel", { label })}>
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="py-1 pr-3 font-medium">{t("namingDict.code")}</th>
                <th className="py-1 pr-3 font-medium">{t("namingDict.meaning")}</th>
                <th className="py-1 pr-3 font-medium">{t("namingDict.value")}</th>
                <th className="py-1 pr-3 font-medium">{t("namingDict.sourceCol")}</th>
                <th className="py-1 font-medium">
                  <span className="sr-only">{t("namingDict.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((e) => (
                <Row key={e.id ?? `legacy:${e.code}`} ws={ws} dimension={dimension} entry={e} blocked={blocked} onDone={onDone} />
              ))}
            </tbody>
          </table>
          {data.total > data.entries.length ? <p className="mt-1 text-xs text-muted-foreground" data-testid="dict-truncated">{t("namingDict.truncated", { shown: data.entries.length, total: data.total })}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function AddRow({ ws, dimension, dim, blocked, onDone }: { ws: string; dimension: string; dim: Dimension | null; blocked: string | null; onDone: (res: DictionaryWriteResponse) => Promise<void> }): ReactElement {
  const [code, setCode] = useState("");
  const [meaning, setMeaning] = useState("");
  const [value, setValue] = useState("");
  const add = useMutation({
    mutationFn: async () => DictionaryWriteResponse.parse(await unwrap(api.POST("/api/v1/workspaces/{ws}/naming-dictionaries/{dimension}/entries", { params: { path: { ws, dimension } }, body: { code: code.trim(), meaning: meaning.trim(), ...(value.trim() ? { value: value.trim() } : {}) } as never }))),
    onSuccess: async (res) => (setCode(""), setMeaning(""), setValue(""), await onDone(res)),
  });
  const why = blocked ?? (code.trim() === "" ? t("namingDict.needCode") : meaning.trim() === "" ? t("namingDict.needMeaning") : add.isPending ? t("campaignNaming.saving") : null);
  const listId = `dict-values-${dimension}`;
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="dict-add">
      <Input size="sm" className="w-32" value={code} onChange={(e) => setCode(e.target.value)} placeholder={t("namingDict.code")} aria-label={t("namingDict.newCode")} disabled={blocked !== null} title={blocked ?? undefined} data-testid="dict-add-code" />
      <Input size="sm" className="w-56" value={meaning} onChange={(e) => setMeaning(e.target.value)} placeholder={t("namingDict.meaning")} aria-label={t("namingDict.newMeaning")} disabled={blocked !== null} title={blocked ?? undefined} data-testid="dict-add-meaning" />
      <Input size="sm" className="w-40" list={listId} value={value} onChange={(e) => setValue(e.target.value)} placeholder={t("namingDict.valuePlaceholder")} aria-label={t("namingDict.newValue")} disabled={blocked !== null} title={blocked ?? undefined} data-testid="dict-add-value" />
      <datalist id={listId}>
        {(dim?.values ?? []).map((v) => (
          <option key={v.code} value={v.code}>
            {v.label}
          </option>
        ))}
      </datalist>
      {why ? (
        <Button size="sm" disabled reason={why} data-testid="dict-add-save">
          {t("namingDict.add")}
        </Button>
      ) : (
        <Button size="sm" onClick={() => add.mutate()} data-testid="dict-add-save" data-tour="dict-add">
          {t("namingDict.add")}
        </Button>
      )}
      {add.error ? <p role="alert" className="text-xs text-destructive">{add.error.message}</p> : null}
    </div>
  );
}

function Row({ ws, dimension, entry, blocked, onDone }: { ws: string; dimension: string; entry: DictionaryEntryView; blocked: string | null; onDone: (res: DictionaryWriteResponse) => Promise<void> }): ReactElement {
  const [edit, setEdit] = useState<{ code: string; meaning: string; value: string; notes: string } | null>(null);
  const id = entry.id;
  const path = { ws, dimension, id: id ?? "" };
  const save = useMutation({
    mutationFn: async (b: { code: string; meaning: string; value: string; notes: string | null }) => DictionaryWriteResponse.parse(await unwrap(api.PATCH("/api/v1/workspaces/{ws}/naming-dictionaries/{dimension}/entries/{id}", { params: { path }, body: b as never }))),
    onSuccess: async (res) => (setEdit(null), await onDone(res)),
  });
  const remove = useMutation({
    mutationFn: async () => DictionaryWriteResponse.parse(await unwrap(api.DELETE("/api/v1/workspaces/{ws}/naming-dictionaries/{dimension}/entries/{id}", { params: { path } }))),
    onSuccess: onDone,
  });
  const why = blocked ?? (entry.legacy || id === null ? t("namingDict.legacyReadOnly") : entry.source === "sync" ? t("namingDict.syncedReadOnly") : save.isPending || remove.isPending ? t("campaignNaming.saving") : null);
  if (edit) {
    const editWhy = edit.code.trim() === "" ? t("namingDict.needCode") : edit.meaning.trim() === "" ? t("namingDict.needMeaning") : null;
    return (
      <tr className="border-b border-border/60" data-testid="dict-row" data-source={entry.source}>
        <td className="py-1 pr-2">
          <Input size="sm" value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value })} aria-label={t("namingDict.code")} data-testid="dict-edit-code" />
        </td>
        <td className="py-1 pr-2">
          <Input size="sm" value={edit.meaning} onChange={(e) => setEdit({ ...edit, meaning: e.target.value })} aria-label={t("namingDict.meaning")} data-testid="dict-edit-meaning" />
        </td>
        <td className="py-1 pr-2">
          <Input size="sm" value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })} aria-label={t("namingDict.value")} data-testid="dict-edit-value" />
        </td>
        <td className="py-1 pr-2">
          <Input size="sm" value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} aria-label={t("namingDict.notes")} placeholder={t("namingDict.notes")} data-testid="dict-edit-notes" />
        </td>
        <td className="py-1 whitespace-nowrap">
          {editWhy ? (
            <Button size="sm" disabled reason={editWhy} data-testid="dict-edit-save">
              {t("namingDict.save")}
            </Button>
          ) : (
            <Button size="sm" onClick={() => save.mutate({ code: edit.code.trim(), meaning: edit.meaning.trim(), value: (edit.value.trim() || edit.code).trim(), notes: edit.notes.trim() || null })} data-testid="dict-edit-save">
              {t("namingDict.save")}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>
            {t("namingDict.cancel")}
          </Button>
          {save.error ? <p role="alert" className="text-xs text-destructive">{save.error.message}</p> : null}
        </td>
      </tr>
    );
  }
  return (
    <tr className="border-b border-border/60" data-testid="dict-row" data-source={entry.source}>
      <td className="py-1 pr-3 font-mono">{entry.code}</td>
      <td className="py-1 pr-3">
        {entry.meaning}
        {entry.notes ? <span className="ml-1 text-muted-foreground">({entry.notes})</span> : null}
      </td>
      <td className="py-1 pr-3 font-mono">{entry.value}</td>
      <td className="py-1 pr-3 text-muted-foreground">{sourceText(entry)}</td>
      <td className="py-1 whitespace-nowrap text-right">
        {why ? (
          <>
            <Button size="sm" variant="ghost" disabled reason={why} data-testid="dict-edit">
              {t("namingDict.edit")}
            </Button>
            <Button size="sm" variant="ghost" disabled reason={why} data-testid="dict-delete">
              {t("namingDict.delete")}
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="ghost" onClick={() => setEdit({ code: entry.code, meaning: entry.meaning, value: entry.value, notes: entry.notes ?? "" })} data-testid="dict-edit">
              {t("namingDict.edit")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => remove.mutate()} data-testid="dict-delete">
              {t("namingDict.delete")}
            </Button>
          </>
        )}
        {remove.error ? <p role="alert" className="text-xs text-destructive">{remove.error.message}</p> : null}
      </td>
    </tr>
  );
}

function Paste({ pending, onSave }: { pending: boolean; onSave: (entries: DictionaryEntryInput[]) => void }): ReactElement {
  const [text, setText] = useState("");
  const parsed = parseDictionaryPaste(text);
  const why = parsed.entries.length === 0 ? t("namingDict.pasteEmpty") : pending ? t("campaignNaming.saving") : null;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        {t("namingDict.pasteHelp")}
        <Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-xs" data-testid="dict-paste" />
      </label>
      <p className="text-xs" data-testid="dict-paste-summary">
        {t("namingDict.pasteSummary", { n: parsed.entries.length, bad: parsed.errors.length, lines: parsed.errors.slice(0, 20).join(", ") })}
      </p>
      <div>
        {why ? (
          <Button size="sm" disabled reason={why} data-testid="dict-paste-save">
            {t("namingDict.pasteSave", { n: parsed.entries.length })}
          </Button>
        ) : (
          <Button size="sm" onClick={() => onSave(parsed.entries)} data-testid="dict-paste-save">
            {t("namingDict.pasteSave", { n: parsed.entries.length })}
          </Button>
        )}
      </div>
    </div>
  );
}

const pct = (x: number) => Math.round(x * 100);

function AiReview({ res, pending, onAccept, onDismiss }: { res: FillDictionaryAiResponse; pending: boolean; onAccept: (entries: DictionaryEntryInput[]) => void; onDismiss: () => void }): ReactElement {
  const [checked, setChecked] = useState<Set<string>>(() => new Set(res.proposals.filter((p) => p.confidence >= 0.5).map((p) => p.code)));
  const accepted = res.proposals.filter((p) => checked.has(p.code));
  const why = accepted.length === 0 ? t("namingDict.aiNoneChecked") : pending ? t("campaignNaming.saving") : null;
  const toggle = (code: string) => setChecked((s) => (s.has(code) ? new Set([...s].filter((c) => c !== code)) : new Set([...s, code])));
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border p-3" data-testid="dict-ai-review">
      <p className="text-sm">{t("namingDict.aiTitle")}</p>
      <p className="text-xs text-muted-foreground">{t("namingDict.aiSent", { codes: res.codes, examples: res.examples })}</p>
      {res.proposals.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("namingDict.aiNone")}</p>
      ) : (
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-border text-muted-foreground">
              <th className="py-1 pr-2 font-medium">
                <span className="sr-only">{t("namingDict.aiAccept")}</span>
              </th>
              <th className="py-1 pr-3 font-medium">{t("namingDict.code")}</th>
              <th className="py-1 pr-3 font-medium">{t("namingDict.meaning")}</th>
              <th className="py-1 pr-3 font-medium">{t("namingDict.value")}</th>
              <th className="py-1 font-medium">{t("namingDict.confidence")}</th>
            </tr>
          </thead>
          <tbody>
            {res.proposals.map((p) => (
              <tr key={p.code} className="border-b border-border/60" data-testid="dict-ai-row">
                <td className="py-1 pr-2">
                  <input type="checkbox" checked={checked.has(p.code)} onChange={() => toggle(p.code)} aria-label={t("namingDict.aiCheck", { code: p.code })} data-testid="dict-ai-check" />
                </td>
                <td className="py-1 pr-3 font-mono">{p.code}</td>
                <td className="py-1 pr-3">{p.meaning}</td>
                <td className="py-1 pr-3 font-mono">{p.value ?? t("namingDict.aiNewValue")}</td>
                <td className="py-1">{pct(p.confidence)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="flex gap-2">
        {why ? (
          <Button size="sm" disabled reason={why} data-testid="dict-ai-accept">
            {t("namingDict.aiAcceptN", { n: accepted.length })}
          </Button>
        ) : (
          <Button size="sm" onClick={() => onAccept(accepted.map((p) => ({ code: p.code, meaning: p.meaning, ...(p.value ? { value: p.value } : {}) })))} data-testid="dict-ai-accept">
            {t("namingDict.aiAcceptN", { n: accepted.length })}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onDismiss} data-testid="dict-ai-dismiss">
          {t("campaignNaming.ai.dismiss")}
        </Button>
      </div>
    </div>
  );
}
