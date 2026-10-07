import { CAMPAIGN_DIMENSION, MatchCoverageResponse, MatchRuleWriteResponse, MatchRulesResponse, equalsPredicate, type MatchRuleGroupT, type NamingConventionView, type OpenCampaign } from "@budget/domain";
import { Button, Input, Select } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus, Trash2 } from "lucide-react";
import { useState, type ReactElement } from "react";
import { Card } from "../../components/page.js";
import { api, unwrap } from "../../lib/api.js";
import { moneyOrDash } from "../../lib/money.js";
import { registryQuery, searchQuery } from "../../lib/queries.js";
import { ConventionPreview, delimiterText } from "../registry/campaign-naming.js";
import { sourcesQuery, type Source } from "./queries.js";

/**
 * EX-5 (ADR-0090): the Spend data page's "Rules" — how campaign mapping works, in one paragraph;
 * the rules of the three kinds (campaign → budget, from the database, from campaign nomenclature),
 * each deletable; and "Add rule". The unassigned / ambiguous campaigns are a plain list under
 * "Unmatched spend" (UnassignedCampaigns), each with "Create rule". No colours, no coverage bar:
 * the coverage endpoint stays (the campaign list comes from it), the page does not draw it.
 * EX-6 (ADR-0092): the naming convention is defined in Registry › Campaign names; here it is
 * shown read-only (separator, position → granularity), with its preview and unresolved tokens,
 * and a link to edit it there.
 */

export const coverageQuery = (ws: string) =>
  queryOptions({
    queryKey: ["match-coverage", ws],
    queryFn: async () => MatchCoverageResponse.parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/match-coverage", { params: { path: { ws }, query: {} } }))),
  });

export const matchRulesQuery = (ws: string) =>
  queryOptions({
    queryKey: ["match-rules", ws],
    queryFn: async () => MatchRulesResponse.parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/match-rules", { params: { path: { ws } } }))),
  });

const refresh = (client: ReturnType<typeof useQueryClient>, ws: string) => Promise.all(["match-coverage", "match-rules", "unmatched", "sources"].map((k) => client.invalidateQueries({ queryKey: [k, ws] })));

/** A rule's predicate in words: `campaign = spring_br`, `campaign in a, b`… */
export function predicateText(g: MatchRuleGroupT): string {
  const parts = g.children.map((c) => {
    if (!("field" in c)) return `(${predicateText(c)})`;
    const v = Array.isArray(c.value) ? c.value.join(", ") : (c.value ?? "");
    const op = { eq: "=", neq: "≠", in: "in", nin: "not in", contains: "contains", starts_with: "starts with", is_empty: "is empty", not_empty: "is set" }[c.op];
    return `${c.field.key} ${op}${v ? ` ${v}` : ""}`;
  });
  const s = parts.join(g.logic === "and" ? " and " : " or ");
  return g.not ? `not (${s})` : s;
}

/** A convention in words: `country · platform (FB=meta) · (ignored)`. */
export function conventionText(c: Pick<NamingConventionView, "tokens">): string {
  return c.tokens
    .map((tk) => {
      if (tk.dimension === null) return t("mapping.ignored");
      const aliases = Object.entries(tk.aliases).map(([k, v]) => `${k}=${v}`);
      return aliases.length ? `${tk.dimension} (${aliases.join(", ")})` : tk.dimension;
    })
    .join(" · ");
}

export { parseAliases, problemText } from "../registry/campaign-naming.js";

type Kind = "campaign" | "database" | "nomenclature";
const KINDS: Kind[] = ["campaign", "database", "nomenclature"];

export function MappingRules({ ws, canEditBudgets }: { ws: string; canEditBudgets: boolean }): ReactElement {
  const client = useQueryClient();
  const { data, isPending, error } = useQuery(matchRulesQuery(ws));
  const { data: sources = [] } = useQuery(sourcesQuery(ws));
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const removeRule = useMutation({
    mutationFn: async (id: string) => unwrap(api.DELETE("/api/v1/match-rules/{id}", { params: { path: { id }, header: { "X-Workspace-Id": ws } } })),
    onSuccess: () => refresh(client, ws),
  });
  const removeReference = useMutation({
    mutationFn: async ({ sourceId, column }: { sourceId: string; column: string }) => {
      const source = sources.find((s) => s.id === sourceId);
      if (!source) throw new Error(t("mapping.needColumn"));
      const mapping = { ...source.mapping, columns: { ...source.mapping.columns, [column]: { role: "ignore" } } };
      return unwrap(api.PATCH("/api/v1/sources/{id}", { params: { path: { id: sourceId }, header: { "X-Workspace-Id": ws } }, body: { mapping } as never }));
    },
    onSuccess: () => refresh(client, ws),
  });
  const busy = removeRule.isPending || removeReference.isPending;
  const { data: dims = [] } = useQuery(registryQuery(ws));
  const rules = data?.rules ?? [];
  const conventions = data?.conventions ?? [];
  const references = data?.references ?? [];
  const empty = rules.length + conventions.length + references.length === 0;
  const del = (why: string | null, onClick: () => void) =>
    why ? (
      <Button size="sm" variant="ghost" className="ml-auto" disabled reason={why} aria-label={t("mapping.deleteRule")} data-testid="mapping-rule-delete">
        <Trash2 className="size-4" aria-hidden />
      </Button>
    ) : (
      <Button size="sm" variant="ghost" className="ml-auto" aria-label={t("mapping.deleteRule")} onClick={onClick} data-testid="mapping-rule-delete">
        <Trash2 className="size-4" aria-hidden />
      </Button>
    );
  const deleting = busy ? t("mapping.deleting") : null;
  return (
    <Card
      title={t("mapping.title")}
      tour="mapping-rules"
      testId="mapping-rules"
      actions={
        adding ? null : (
          <Button size="sm" variant="outline" onClick={() => (setAdding(true), setNotice(null))} data-testid="mapping-add">
            <Plus className="size-4" aria-hidden />
            {t("mapping.addRule")}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground" data-testid="mapping-help">{t("mapping.help")}</p>
        {error ? <p role="alert" className="text-sm text-destructive">{error.message}</p> : null}
        {notice ? <p role="status" className="text-sm" data-testid="mapping-notice">{notice}</p> : null}
        {adding ? <AddRule ws={ws} sources={sources} canEditBudgets={canEditBudgets} onCancel={() => setAdding(false)} onDone={(msg) => (setAdding(false), setNotice(msg))} /> : null}
        {isPending ? (
          <p className="text-sm text-muted-foreground">{t("shell.loading")}</p>
        ) : empty ? (
          <p className="text-sm text-muted-foreground" data-testid="mapping-rules-empty">{t("mapping.rulesNone")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border" data-testid="mapping-rule-list">
            {references.map((r) => (
              <li key={`${r.sourceId}:${r.column}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm" data-testid="mapping-rule" data-kind="database">
                <span className="w-48 shrink-0 text-xs text-muted-foreground">{t("mapping.kind.database")}</span>
                <span>{t("mapping.referenceLine", { source: r.sourceName, column: r.column })}</span>
                {del(deleting, () => removeReference.mutate({ sourceId: r.sourceId, column: r.column }))}
              </li>
            ))}
            {rules.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm" data-testid="mapping-rule" data-kind="campaign">
                <span className="w-48 shrink-0 text-xs text-muted-foreground">{t("mapping.kind.campaign")}</span>
                <span>{t("mapping.ruleLine", { predicate: predicateText(r.predicate), budget: r.envelopeName })}</span>
                <span className="text-xs text-muted-foreground">{r.startDate || r.endDate ? t("mapping.ruleDates", { from: r.startDate ?? "…", to: r.endDate ?? "…" }) : t("mapping.ruleOpen")}</span>
                {del(!canEditBudgets ? t("mapping.noEditReason") : deleting, () => removeRule.mutate(r.id))}
              </li>
            ))}
            {conventions.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm" data-testid="mapping-rule" data-kind="nomenclature">
                <span className="w-48 shrink-0 text-xs text-muted-foreground">{t("mapping.kind.nomenclature")}</span>
                <span>{t("mapping.conventionLine", { delimiter: delimiterText(c.delimiter), parts: conventionText(c) })}</span>
                <RegistryLink ws={ws} />
              </li>
            ))}
          </ul>
        )}
        {conventions.length > 0 ? <ConventionPreview ws={ws} convention={conventions[conventions.length - 1] as NamingConventionView} dims={dims} mapTo={null} /> : null}
        {[removeRule.error, removeReference.error].map((e, i) => (e ? <p key={i} role="alert" className="text-xs text-destructive">{e.message}</p> : null))}
      </div>
    </Card>
  );
}

function AddRule({ ws, sources, canEditBudgets, onCancel, onDone }: { ws: string; sources: Source[]; canEditBudgets: boolean; onCancel: () => void; onDone: (msg: string) => void }): ReactElement {
  const [kind, setKind] = useState<Kind>("nomenclature");
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3" data-testid="mapping-add-form">
      <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <legend className="mb-1 text-xs text-muted-foreground">{t("mapping.kindLabel")}</legend>
        {KINDS.map((k) => (
          <label key={k} className="flex items-center gap-1.5">
            <input type="radio" name="mapping-kind" value={k} checked={kind === k} onChange={() => setKind(k)} data-testid={`mapping-kind-${k}`} />
            {t(`mapping.kind.${k}` as MessageKey)}
          </label>
        ))}
      </fieldset>
      <p className="text-xs text-muted-foreground">{t(`mapping.kindHelp.${kind}` as MessageKey)}</p>
      {kind === "campaign" ? <CampaignRuleForm ws={ws} canEditBudgets={canEditBudgets} onDone={onDone} /> : kind === "database" ? <DatabaseRuleForm ws={ws} sources={sources} onDone={onDone} /> : <NomenclatureInRegistry ws={ws} />}
      <div>
        <Button size="sm" variant="ghost" onClick={onCancel} data-testid="mapping-add-cancel">
          {t("mapping.cancel")}
        </Button>
      </div>
    </div>
  );
}

/** The naming convention is edited in Registry › Campaign names (EX-6). */
function RegistryLink({ ws }: { ws: string }): ReactElement {
  return (
    <Link to="/w/$ws/admin/registry" params={{ ws }} search={{ tab: "naming" } as never} className="ml-auto text-xs text-primary hover:underline" data-testid="mapping-edit-naming">
      {t("campaignNaming.editInRegistry")}
    </Link>
  );
}

function NomenclatureInRegistry({ ws }: { ws: string }): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="mapping-naming-in-registry">
      <p className="text-muted-foreground">{t("campaignNaming.setInRegistry")}</p>
      <RegistryLink ws={ws} />
    </div>
  );
}

/** Pick a budget by search; the picked one is highlighted by `aria-pressed`. */
function BudgetPicker({ ws, initial, candidates = [], onPick, label }: { ws: string; initial: string; candidates?: Array<{ id: string; name: string }>; onPick: (b: { id: string; name: string }) => void; label: (name: string) => string }): ReactElement {
  const [q, setQ] = useState(initial);
  const { data } = useQuery({ ...searchQuery(ws, q.trim(), { types: "envelope", limit: 6 }), enabled: q.trim().length > 1 });
  const hits = [...candidates.map((c) => ({ id: c.id, title: c.name, path: null as string | null })), ...(data?.groups.find((g) => g.type === "envelope")?.hits ?? []).filter((h) => !candidates.some((c) => c.id === h.id)).map((h) => ({ id: h.id, title: h.title, path: h.path ?? null }))];
  return (
    <div className="flex flex-col gap-1.5" data-testid="mapping-picker">
      <Input type="search" size="sm" value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("mapping.budgetSearch")} placeholder={t("mapping.budgetSearch")} data-testid="mapping-search" />
      <ul className="flex flex-col gap-1">
        {hits.map((h) => (
          <li key={h.id}>
            <button type="button" className="w-full rounded-md px-2 py-1 text-left text-sm hover:bg-accent" aria-label={label(h.title)} onClick={() => onPick({ id: h.id, name: h.title })} data-testid="mapping-option">
              <span className="font-medium">{h.title}</span>
              {h.path ? <span className="ml-2 text-xs text-muted-foreground">{h.path}</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function useCreateCampaignRule(ws: string, onDone: (msg: string) => void) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ campaign, envelopeId }: { campaign: string; name: string; envelopeId: string }) =>
      MatchRuleWriteResponse.parse(await unwrap(api.POST("/api/v1/workspaces/{ws}/match-rules", { params: { path: { ws } }, body: { envelopeId, predicate: equalsPredicate(CAMPAIGN_DIMENSION, campaign) } as never }))),
    onSuccess: async (res, v) => {
      await refresh(client, ws);
      onDone(t("mapping.assigned", { campaign: v.name, budget: res.rule.envelopeName, n: res.rematch.spend + res.rematch.kpi + res.rematch.projection }));
    },
  });
}

function CampaignRuleForm({ ws, canEditBudgets, onDone }: { ws: string; canEditBudgets: boolean; onDone: (msg: string) => void }): ReactElement {
  const [campaign, setCampaign] = useState("");
  const create = useCreateCampaignRule(ws, onDone);
  if (!canEditBudgets) return <p className="text-sm text-muted-foreground">{t("mapping.noEditReason")}</p>;
  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        {t("mapping.campaign")}
        <Input size="sm" value={campaign} onChange={(e) => setCampaign(e.target.value)} data-testid="mapping-campaign" />
      </label>
      {campaign.trim() ? (
        <BudgetPicker ws={ws} initial="" onPick={(b) => (create.isPending ? undefined : create.mutate({ campaign: campaign.trim(), name: campaign.trim(), envelopeId: b.id }))} label={() => t("mapping.assignTo", { campaign: campaign.trim() })} />
      ) : (
        <p className="text-xs text-muted-foreground">{t("mapping.needCampaign")}</p>
      )}
      {create.error ? <p role="alert" className="text-xs text-destructive">{create.error.message}</p> : null}
    </div>
  );
}

function DatabaseRuleForm({ ws, sources, onDone }: { ws: string; sources: Source[]; onDone: (msg: string) => void }): ReactElement {
  const client = useQueryClient();
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? "");
  const [column, setColumn] = useState("");
  const source = sources.find((s) => s.id === sourceId);
  const save = useMutation({
    mutationFn: async () => {
      if (!source) throw new Error(t("mapping.needColumn"));
      // One budget_ref column per source: any other one goes back to ignored.
      const columns = Object.fromEntries(Object.entries(source.mapping.columns).map(([k, c]) => [k, c["role"] === "budget_ref" ? { role: "ignore" } : c]));
      const mapping = { ...source.mapping, columns: { ...columns, [column.trim()]: { role: "budget_ref" } } };
      return unwrap(api.PATCH("/api/v1/sources/{id}", { params: { path: { id: source.id }, header: { "X-Workspace-Id": ws } }, body: { mapping } as never }));
    },
    onSuccess: async () => {
      await refresh(client, ws);
      onDone(t("mapping.savedReference", { source: source?.name ?? "", column: column.trim() }));
    },
  });
  const why = !source || column.trim() === "" ? t("mapping.needColumn") : save.isPending ? t("mapping.saving") : null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("mapping.source")}
          <Select value={sourceId} onChange={(e) => setSourceId(e.target.value)} data-testid="mapping-source">
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("mapping.column")}
          <Input size="sm" list="mapping-columns" value={column} onChange={(e) => setColumn(e.target.value)} data-testid="mapping-column" />
          <datalist id="mapping-columns">
            {Object.keys(source?.mapping.columns ?? {}).map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{t("mapping.nextRun")}</p>
      <div>
        {why ? (
          <Button size="sm" disabled reason={why} data-testid="mapping-save">
            {t("mapping.save")}
          </Button>
        ) : (
          <Button size="sm" onClick={() => save.mutate()} data-testid="mapping-save">
            {t("mapping.save")}
          </Button>
        )}
      </div>
      {save.error ? <p role="alert" className="text-xs text-destructive">{save.error.message}</p> : null}
    </div>
  );
}

/** Why a campaign is not on a budget, in words (no colours). */
export function whyText(o: OpenCampaign): string {
  if (o.status === "ambiguous") return t("mapping.why.ambiguous", { budgets: o.candidates.map((c) => c.name).join(", ") });
  return t(`mapping.why.${o.reason ?? "none"}` as MessageKey);
}

/** The campaigns that land on no budget, largest first, each with "Create rule" (campaign → budget). */
export function UnassignedCampaigns({ ws, canEditBudgets }: { ws: string; canEditBudgets: boolean }): ReactElement {
  const { data: cov, isPending } = useQuery(coverageQuery(ws));
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1.5 border-t border-border pt-3" data-testid="mapping-open" data-tour="mapping-open">
      <h3 className="text-sm font-medium">{t("mapping.open")}</h3>
      {notice ? <p role="status" className="text-sm" data-testid="mapping-open-notice">{notice}</p> : null}
      {isPending || !cov ? (
        <p className="text-sm text-muted-foreground">{t("shell.loading")}</p>
      ) : cov.open.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="mapping-all-matched">{t("mapping.openNone")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {cov.open.map((o) => {
            const key = `${o.campaign ?? ""}|${o.status}|${o.reason ?? ""}`;
            const name = o.label ?? o.campaign ?? t("mapping.noCampaign");
            const why = o.campaign === null ? t("mapping.noCampaignReason") : !canEditBudgets ? t("mapping.noEditReason") : null;
            return (
              <li key={key} className="py-2" data-testid="mapping-open-row">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <span className="font-medium">{name}</span>
                  {o.label && o.campaign ? <span className="text-xs text-muted-foreground">{o.campaign}</span> : null}
                  <span className="tabular text-muted-foreground">{t("mapping.openLine", { amount: moneyOrDash(o.amount, cov.currency), from: o.firstDate, to: o.lastDate })}</span>
                  <span className="text-muted-foreground" data-testid="mapping-open-why">{whyText(o)}</span>
                  {why ? (
                    <Button size="sm" variant="outline" className="ml-auto" disabled reason={why} data-testid="mapping-create-rule">
                      {t("mapping.createRule")}
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" className="ml-auto" aria-expanded={open === key} onClick={() => setOpen(open === key ? null : key)} data-testid="mapping-create-rule">
                      {t("mapping.createRule")}
                    </Button>
                  )}
                </div>
                {open === key && o.campaign !== null ? <CreateRuleFor ws={ws} campaign={o.campaign} name={name} candidates={o.candidates} onDone={(msg) => (setOpen(null), setNotice(msg))} /> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function CreateRuleFor({ ws, campaign, name, candidates, onDone }: { ws: string; campaign: string; name: string; candidates: OpenCampaign["candidates"]; onDone: (msg: string) => void }): ReactElement {
  const create = useCreateCampaignRule(ws, onDone);
  return (
    <div className="mt-2 flex flex-col gap-1.5 rounded-lg bg-surface p-3">
      <BudgetPicker ws={ws} initial={name} candidates={candidates} onPick={(b) => (create.isPending ? undefined : create.mutate({ campaign, name, envelopeId: b.id }))} label={() => t("mapping.assignTo", { campaign: name })} />
      {create.error ? <p role="alert" className="text-xs text-destructive">{create.error.message}</p> : null}
    </div>
  );
}
