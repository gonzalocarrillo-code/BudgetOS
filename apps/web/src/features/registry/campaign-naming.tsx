import {
  AnalyzeNamesResponse,
  CAMPAIGN_DIMENSION,
  NamingConventionPreviewResponse,
  NamingConventionSaveResponse,
  NamingConventionState,
  NamingConventionWriteResponse,
  SuggestNamingResponse,
  dictionaryKindFor,
  type ConventionProblem,
  type ConventionProposal,
  type CreateNamingConventionInput,
  type DictionaryKind,
  type NamingConventionDelimiter,
  type NamingConventionView,
  type UnresolvedToken,
} from "@budget/domain";
import { Button, Input, Select, Textarea } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactElement } from "react";
import { api, unwrap } from "../../lib/api.js";
import { moneyOrDash } from "../../lib/money.js";
import type { Dimension } from "../../lib/queries.js";

/**
 * EX-6 (ADR-0092): the workspace's campaign naming convention, defined in Registry next to the
 * granularities. One separator; each granularity may have a position in the name, reads its
 * values through the built-in dictionary of its kind (shown, never typed) and has its aliases.
 * "Analyze names" (deterministic) and "Suggest with AI" (support only, nothing applied) fill the
 * positions; a live preview shows each name's values, unresolved tokens plainly, and "Map to…"
 * stores an alias. Saving re-matches the campaign facts. The Spend data page shows it read-only.
 */

export const namingQuery = (ws: string) =>
  queryOptions({
    queryKey: ["naming-convention", ws],
    queryFn: async () => NamingConventionState.parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/naming-convention", { params: { path: { ws } } }))),
  });

const DELIMITERS: NamingConventionDelimiter[] = ["_", "-", ".", "|", "/", ":", "·", "+", " "];

export const delimiterText = (d: string): string => (d === " " ? t("mapping.delimiterSpace") : d);
export const dictionaryName = (kind: DictionaryKind | null): string => (kind === null ? t("campaignNaming.noDictionary") : t(`campaignNaming.dict.${kind}` as MessageKey));

/** `FB=meta, IG=meta` → { FB: "meta", IG: "meta" }. */
export function parseAliases(s: string): Record<string, string> {
  return Object.fromEntries(
    s
      .split(",")
      .map((pair) => pair.split("=").map((x) => x.trim()))
      .filter((kv): kv is [string, string] => kv.length === 2 && kv[0] !== "" && kv[1] !== ""),
  );
}
const aliasText = (a: Record<string, string>): string =>
  Object.entries(a)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");

export function problemText(p: ConventionProblem): string {
  return p.kind === "parts" ? t("mapping.problem.parts", { found: p.found, expected: p.expected }) : p.kind === "empty" ? t("mapping.problem.empty", { position: p.position }) : t("mapping.problem.unknown_value", { value: p.value, dimension: p.dimension });
}

interface Draft {
  delimiter: NamingConventionDelimiter;
  tokens: Array<{ dimension: string | null; aliases: string }>;
}

const draftOf = (c: Pick<ConventionProposal, "delimiter" | "tokens"> | null): Draft => (c ? { delimiter: c.delimiter, tokens: c.tokens.map((tk) => ({ dimension: tk.dimension, aliases: aliasText(tk.aliases) })) } : { delimiter: "_", tokens: [{ dimension: null, aliases: "" }] });

/** The draft as the API takes it, or null while no position names a granularity. */
export function draftInput(d: Draft): CreateNamingConventionInput | null {
  const tokens = d.tokens.map((tk) => ({ dimension: tk.dimension, aliases: tk.dimension ? parseAliases(tk.aliases) : {} }));
  return tokens.some((tk) => tk.dimension !== null) ? { delimiter: d.delimiter, tokens } : null;
}

const sameConvention = (a: CreateNamingConventionInput | null, b: Pick<NamingConventionView, "delimiter" | "tokens"> | null) => a !== null && b !== null && JSON.stringify({ d: a.delimiter, t: a.tokens }) === JSON.stringify({ d: b.delimiter, t: b.tokens });

const linesOf = (s: string) => s.split("\n").map((l) => l.trim()).filter((l) => l !== "");

export function CampaignNaming({ ws, dims, canManage }: { ws: string; dims: Dimension[]; canManage: boolean }): ReactElement {
  const client = useQueryClient();
  const { data: state } = useQuery(namingQuery(ws));
  const saved = state?.convention ?? null;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [names, setNames] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const current = draft ?? draftOf(saved);
  const input = draftInput(current);
  const granularities = dims.filter((d) => d.isActive && d.key !== CAMPAIGN_DIMENSION);
  const pasted = linesOf(names);
  const refresh = () => Promise.all(["naming-convention", "match-rules", "match-coverage", "registry", "naming-preview"].map((k) => client.invalidateQueries({ queryKey: [k, ws] })));

  const analyze = useMutation({
    mutationFn: async () => AnalyzeNamesResponse.parse(await unwrap(api.POST("/api/v1/workspaces/{ws}/naming-conventions/analyze", { params: { path: { ws } }, body: (pasted.length ? { names: pasted.slice(0, 1000) } : {}) as never }))),
  });
  const suggest = useMutation({
    mutationFn: async () => SuggestNamingResponse.parse(await unwrap(api.POST("/api/v1/workspaces/{ws}/naming-conventions/suggest", { params: { path: { ws } }, body: (pasted.length ? { names: pasted.slice(0, 300) } : {}) as never }))),
  });
  const save = useMutation({
    mutationFn: async (body: CreateNamingConventionInput) => NamingConventionSaveResponse.parse(await unwrap(api.PUT("/api/v1/workspaces/{ws}/naming-convention", { params: { path: { ws } }, body: body as never }))),
    onSuccess: async (res) => {
      setDraft(null);
      await refresh();
      const n = res.rematch.spend + res.rematch.kpi + res.rematch.projection;
      setNotice(t("campaignNaming.saved", { n, created: res.createdValues.length ? t("campaignNaming.created", { n: res.createdValues.length }) : "" }));
    },
  });
  const remove = useMutation({
    mutationFn: async (id: string) => NamingConventionWriteResponse.parse(await unwrap(api.DELETE("/api/v1/naming-conventions/{id}", { params: { path: { id }, header: { "X-Workspace-Id": ws } } }))),
    onSuccess: async () => (setDraft(null), await refresh(), setNotice(t("campaignNaming.removed"))),
  });

  const set = (d: Partial<Draft>) => setDraft({ ...current, ...d });
  const setToken = (i: number, p: Partial<Draft["tokens"][number]>) => set({ tokens: current.tokens.map((tk, j) => (j === i ? { ...tk, ...p } : tk)) });
  const setParts = (n: number) => set({ tokens: Array.from({ length: n }, (_, i) => current.tokens[i] ?? { dimension: null, aliases: "" }) });
  const unchanged = sameConvention(input, saved);
  const blocked = !canManage ? t("campaignNaming.noManage") : null;
  const saveWhy = blocked ?? (input === null ? t("campaignNaming.needDimension") : unchanged ? t("campaignNaming.unchanged") : save.isPending ? t("campaignNaming.saving") : null);
  const aiWhy = blocked ?? (state && !state.aiAvailable ? t("campaignNaming.aiOff") : suggest.isPending ? t("campaignNaming.suggesting") : null);
  const analyzeWhy = blocked ?? (analyze.isPending ? t("campaignNaming.analyzing") : null);
  const used = new Set(current.tokens.flatMap((tk) => (tk.dimension ? [tk.dimension] : [])));

  return (
    <div className="flex flex-col gap-4" data-testid="campaign-naming" data-tour="registry-naming">
      <p className="text-sm text-muted-foreground">{t("campaignNaming.help")}</p>
      {notice ? <p role="status" className="text-sm" data-testid="naming-notice">{notice}</p> : null}
      {state && state.others > 0 ? <p className="text-xs text-muted-foreground">{t("campaignNaming.others", { n: state.others })}</p> : null}

      <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("campaignNaming.names")}
          <Textarea rows={4} value={names} onChange={(e) => setNames(e.target.value)} className="font-mono text-xs" data-testid="naming-names" />
        </label>
        <div className="flex flex-wrap gap-2">
          {analyzeWhy ? (
            <Button size="sm" variant="outline" disabled reason={analyzeWhy} data-testid="naming-analyze">
              {t("campaignNaming.analyze")}
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => analyze.mutate()} data-testid="naming-analyze" data-tour="naming-analyze">
              {t("campaignNaming.analyze")}
            </Button>
          )}
          {aiWhy ? (
            <Button size="sm" variant="ghost" disabled reason={aiWhy} data-testid="naming-suggest">
              {t("campaignNaming.suggestAi")}
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => suggest.mutate()} data-testid="naming-suggest" data-tour="naming-suggest">
              {t("campaignNaming.suggestAi")}
            </Button>
          )}
        </div>
        {[analyze.error, suggest.error].map((e, i) => (e ? <p key={i} role="alert" className="text-xs text-destructive">{e.message}</p> : null))}
        {analyze.data ? <AnalysisView a={analyze.data} dims={granularities} onUse={() => (setDraft(draftOf(analyze.data.proposal)), analyze.reset())} /> : null}
        {suggest.data ? <SuggestionView s={suggest.data} dims={granularities} onUse={() => (setDraft(draftOf(suggest.data.proposal)), suggest.reset())} onDismiss={() => suggest.reset()} /> : null}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("campaignNaming.separator")}
          <Select value={current.delimiter} onChange={(e) => set({ delimiter: e.target.value as NamingConventionDelimiter })} data-testid="naming-separator">
            {DELIMITERS.map((d) => (
              <option key={d} value={d}>
                {delimiterText(d)}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("campaignNaming.parts")}
          <Input type="number" size="sm" className="w-20" min={1} max={20} value={current.tokens.length} onChange={(e) => setParts(Math.min(20, Math.max(1, Number(e.target.value) || 1)))} data-testid="naming-part-count" />
        </label>
      </div>

      <ol className="flex flex-col gap-1.5" data-testid="naming-positions">
        {current.tokens.map((tk, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2 text-sm" data-testid="naming-position">
            <span className="w-20 text-xs text-muted-foreground">{t("campaignNaming.position", { n: i + 1 })}</span>
            <Select value={tk.dimension ?? ""} onChange={(e) => setToken(i, { dimension: e.target.value || null })} aria-label={t("campaignNaming.granularityFor", { n: i + 1 })} data-testid="naming-position-dimension">
              <option value="">{t("campaignNaming.ignore")}</option>
              {granularities
                .filter((d) => d.key === tk.dimension || !used.has(d.key))
                .map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
            </Select>
            {tk.dimension ? (
              <>
                <span className="text-xs text-muted-foreground" data-testid="naming-position-dictionary">
                  {dictionaryName(dictionaryKindFor(tk.dimension))}
                </span>
                <Input size="sm" className="w-56" value={tk.aliases} onChange={(e) => setToken(i, { aliases: e.target.value })} placeholder={t("campaignNaming.aliases")} aria-label={t("campaignNaming.aliasesFor", { n: i + 1 })} data-testid="naming-position-aliases" />
              </>
            ) : null}
          </li>
        ))}
      </ol>

      {input ? <ConventionPreview ws={ws} convention={input} names={pasted.slice(0, 50)} dims={granularities} mapTo={canManage && unchanged ? "alias" : canManage ? "save-first" : null} onMapped={refresh} /> : null}

      <div className="flex flex-wrap gap-2">
        {saveWhy ? (
          <Button size="sm" disabled reason={saveWhy} data-testid="naming-save">
            {t("campaignNaming.save")}
          </Button>
        ) : (
          <Button size="sm" onClick={() => input && save.mutate(input)} data-testid="naming-save" data-tour="naming-save">
            {t("campaignNaming.save")}
          </Button>
        )}
        {draft ? (
          <Button size="sm" variant="ghost" onClick={() => setDraft(null)} data-testid="naming-discard">
            {t("campaignNaming.discard")}
          </Button>
        ) : null}
        {saved === null || blocked || remove.isPending ? (
          <Button size="sm" variant="ghost" className="ml-auto" disabled reason={blocked ?? (saved === null ? t("campaignNaming.removeNone") : t("campaignNaming.saving"))} data-testid="naming-remove">
            {t("campaignNaming.remove")}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => remove.mutate(saved.id)} data-testid="naming-remove">
            {t("campaignNaming.remove")}
          </Button>
        )}
      </div>
      {[save.error, remove.error].map((e, i) => (e ? <p key={i} role="alert" className="text-xs text-destructive">{e.message}</p> : null))}
    </div>
  );
}

const pct = (x: number) => Math.round(x * 100);
const dimLabel = (dims: Dimension[], key: string | null) => (key === null ? t("campaignNaming.ignore") : (dims.find((d) => d.key === key)?.label ?? key));

function AnalysisView({ a, dims, onUse }: { a: AnalyzeNamesResponse; dims: Dimension[]; onUse: () => void }): ReactElement {
  if (a.positions.length === 0) return <p className="text-sm text-muted-foreground" data-testid="naming-analysis">{t("campaignNaming.analysis.empty", { n: a.total })}</p>;
  return (
    <div className="flex flex-col gap-1.5" data-testid="naming-analysis">
      <p className="text-sm">{t("campaignNaming.analysis.title", { n: a.total, fitting: a.fitting, parts: a.partCount, delimiter: delimiterText(a.delimiter) })}</p>
      <ol className="flex flex-col gap-0.5 text-xs">
        {a.positions.map((p) => (
          <li key={p.position} className="flex flex-wrap gap-x-3" data-testid="naming-analysis-row">
            <span className="w-20 text-muted-foreground">{t("campaignNaming.position", { n: p.position })}</span>
            <span className="font-mono">{t("campaignNaming.analysis.row", { examples: p.examples.join(", "), cardinality: p.cardinality })}</span>
            <span>{p.best ? t("campaignNaming.analysis.best", { hit: pct(p.best.hitRate), dictionary: p.best.kind ? dictionaryName(p.best.kind) : dimLabel(dims, p.best.dimension) }) : t("campaignNaming.analysis.none")}</span>
            <span className="text-muted-foreground">→ {dimLabel(dims, a.proposal.tokens[p.position - 1]?.dimension ?? null)}</span>
          </li>
        ))}
      </ol>
      <div>
        <Button size="sm" variant="outline" onClick={onUse} data-testid="naming-analysis-use">
          {t("campaignNaming.analysis.use")}
        </Button>
      </div>
    </div>
  );
}

function SuggestionView({ s, dims, onUse, onDismiss }: { s: SuggestNamingResponse; dims: Dimension[]; onUse: () => void; onDismiss: () => void }): ReactElement {
  return (
    <div className="flex flex-col gap-1.5" data-testid="naming-suggestion">
      <p className="text-sm">{t("campaignNaming.ai.title")}</p>
      <p className="text-xs text-muted-foreground">{t("campaignNaming.ai.sent", { n: s.names })}</p>
      <ol className="flex flex-col gap-0.5 text-xs">
        {s.suggestion.positions.map((p, i) => (
          <li key={i} data-testid="naming-suggestion-row">
            {t("campaignNaming.ai.position", { n: i + 1, dimension: dimLabel(dims, p.dimension), confidence: pct(p.confidence) })}
            {s.suggestion.mappings
              .filter((m) => m.position === i + 1)
              .map((m) => (
                <span key={m.token} className="ml-3 text-muted-foreground">
                  {t("campaignNaming.ai.mapping", { token: m.token, value: m.value, confidence: pct(m.confidence) })}
                </span>
              ))}
          </li>
        ))}
      </ol>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={onUse} data-testid="naming-suggestion-use">
          {t("campaignNaming.ai.use")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss} data-testid="naming-suggestion-dismiss">
          {t("campaignNaming.ai.dismiss")}
        </Button>
      </div>
    </div>
  );
}

/**
 * The live preview: name → the value each granularity reads (unresolved tokens say so in words,
 * no colours), and the unresolved tokens over every campaign with their spend. `mapTo`: "alias"
 * offers "Map to…" (stores an alias on the saved convention); "save-first" says why not yet; null
 * shows none (read-only, the Spend data page).
 */
export function ConventionPreview({ ws, convention, names = [], dims, mapTo, onMapped }: { ws: string; convention: CreateNamingConventionInput; names?: string[]; dims: Dimension[]; mapTo: "alias" | "save-first" | null; onMapped?: () => Promise<unknown> }): ReactElement {
  const body = { convention, ...(names.length ? { names } : {}) };
  const preview = useQuery({
    queryKey: ["naming-preview", ws, JSON.stringify(body)],
    queryFn: async () => NamingConventionPreviewResponse.parse(await unwrap(api.POST("/api/v1/workspaces/{ws}/naming-conventions/preview", { params: { path: { ws } }, body: body as never }))),
  });
  const named = convention.tokens.flatMap((tk, i) => (tk.dimension ? [{ i, dimension: tk.dimension }] : []));
  const data = preview.data;
  return (
    <div className="flex flex-col gap-3" data-testid="naming-preview">
      <h4 className="text-xs font-medium text-muted-foreground">{t("campaignNaming.preview")}</h4>
      {preview.error ? <p role="alert" className="text-xs text-destructive">{preview.error.message}</p> : null}
      {data && data.samples.length === 0 ? <p className="text-xs text-muted-foreground">{t("mapping.previewNone")}</p> : null}
      {data && data.samples.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="py-1 pr-3 font-medium">{t("campaignNaming.previewName")}</th>
                {named.map((n) => (
                  <th key={n.i} className="py-1 pr-3 font-medium">
                    {dimLabel(dims, n.dimension)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.samples.map((s) => (
                <tr key={`${s.campaign ?? ""}:${s.name}`} className="border-b border-border/60" data-testid="naming-preview-row">
                  <td className="py-1 pr-3 font-mono">{s.name}</td>
                  {s.parts.length === 0 ? (
                    <td colSpan={Math.max(1, named.length)} className="py-1 pr-3 text-muted-foreground">
                      {s.problem ? problemText(s.problem) : ""}
                    </td>
                  ) : (
                    named.map((n) => {
                      const p = s.parts[n.i];
                      return (
                        <td key={n.i} className="py-1 pr-3" data-testid="naming-preview-cell" data-resolved={p?.code ? "yes" : "no"}>
                          {p?.code ? (
                            <>
                              {p.code}
                              {p.source ? <span className="ml-1 text-muted-foreground">({t(`campaignNaming.source.${p.source}` as MessageKey)})</span> : null}
                            </>
                          ) : (
                            <span className="font-medium underline decoration-dotted">{t("campaignNaming.unresolvedCell", { token: p?.raw ?? "" })}</span>
                          )}
                        </td>
                      );
                    })
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {data ? <Unresolved ws={ws} list={data.unresolved} currency={data.currency} dims={dims} mapTo={mapTo} {...(onMapped ? { onMapped } : {})} /> : null}
    </div>
  );
}

function Unresolved({ ws, list, currency, dims, mapTo, onMapped }: { ws: string; list: UnresolvedToken[]; currency: string | null; dims: Dimension[]; mapTo: "alias" | "save-first" | null; onMapped?: () => Promise<unknown> }): ReactElement {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1" data-testid="naming-unresolved">
      <h4 className="text-xs font-medium text-muted-foreground">{t("campaignNaming.unresolved")}</h4>
      {list.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="naming-unresolved-none">{t("campaignNaming.unresolvedNone")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border text-xs">
          {list.map((u) => {
            const key = `${u.position}:${u.token}`;
            return (
              <li key={key} className="py-1.5" data-testid="naming-unresolved-row">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span>{t("campaignNaming.unresolvedLine", { position: u.position, dimension: dimLabel(dims, u.dimension), token: u.token, campaigns: u.campaigns, amount: u.amount === null || currency === null ? t("common.noValue") : moneyOrDash(u.amount, currency) })}</span>
                  {mapTo === "alias" ? (
                    <Button size="sm" variant="outline" className="ml-auto" aria-expanded={open === key} onClick={() => setOpen(open === key ? null : key)} data-testid="naming-map-to">
                      {t("campaignNaming.mapTo")}
                    </Button>
                  ) : mapTo === "save-first" ? (
                    <Button size="sm" variant="outline" className="ml-auto" disabled reason={t("campaignNaming.mapNeedsSave")} data-testid="naming-map-to">
                      {t("campaignNaming.mapTo")}
                    </Button>
                  ) : null}
                </div>
                {open === key ? <MapTo ws={ws} token={u} dim={dims.find((d) => d.key === u.dimension) ?? null} onDone={async () => (setOpen(null), await onMapped?.())} /> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function MapTo({ ws, token, dim, onDone }: { ws: string; token: UnresolvedToken; dim: Dimension | null; onDone: () => Promise<unknown> }): ReactElement {
  const [value, setValue] = useState("");
  const save = useMutation({
    mutationFn: async () => NamingConventionSaveResponse.parse(await unwrap(api.POST("/api/v1/workspaces/{ws}/naming-convention/aliases", { params: { path: { ws } }, body: { dimension: token.dimension, token: token.token, value: value.trim() } as never }))),
    onSuccess: onDone,
  });
  const listId = `naming-values-${token.position}`;
  const why = value.trim() === "" ? t("campaignNaming.mapNeedValue") : save.isPending ? t("campaignNaming.saving") : null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2">
      <Input size="sm" className="w-48" list={listId} value={value} onChange={(e) => setValue(e.target.value)} aria-label={t("campaignNaming.mapToLabel", { dimension: dim?.label ?? token.dimension, token: token.token })} data-testid="naming-map-value" />
      <datalist id={listId}>
        {(dim?.values ?? []).map((v) => (
          <option key={v.code} value={v.code}>
            {v.label}
          </option>
        ))}
      </datalist>
      {why ? (
        <Button size="sm" disabled reason={why} data-testid="naming-map-save">
          {t("campaignNaming.mapSave")}
        </Button>
      ) : (
        <Button size="sm" onClick={() => save.mutate()} data-testid="naming-map-save">
          {t("campaignNaming.mapSave")}
        </Button>
      )}
      {save.error ? <p role="alert" className="text-xs text-destructive">{save.error.message}</p> : null}
    </div>
  );
}
