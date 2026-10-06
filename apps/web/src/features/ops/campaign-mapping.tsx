import { CAMPAIGN_DIMENSION, MatchCoverageResponse, MatchRuleWriteResponse, MatchRulesResponse, equalsPredicate, type MatchRuleGroupT, type OpenCampaign } from "@budget/domain";
import { Button, Input, StatusChip, cn } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Decimal } from "decimal.js";
import { Trash2 } from "lucide-react";
import { useState, type ReactElement } from "react";
import { Card } from "../../components/page.js";
import { api, unwrap } from "../../lib/api.js";
import { moneyOrDash } from "../../lib/money.js";
import { searchQuery } from "../../lib/queries.js";

/**
 * EX-1 (ADR-0085): the Spend data page's "Campaign mapping". The coverage bar splits the period's
 * live spend into matched / unassigned / ambiguous (the server's sums; nothing is computed here but
 * the bar's widths); the open campaigns, largest first, each with "Assign to budget", which creates
 * a match rule `campaign = value` and re-matches at once; the rules, each deletable.
 */

export const coverageQuery = (ws: string, from: string | undefined, to: string | undefined) =>
  queryOptions({
    queryKey: ["match-coverage", ws, from ?? "", to ?? ""],
    queryFn: async () => MatchCoverageResponse.parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/match-coverage", { params: { path: { ws }, query: { ...(from ? { from } : {}), ...(to ? { to } : {}) } } }))),
  });

export const matchRulesQuery = (ws: string) =>
  queryOptions({
    queryKey: ["match-rules", ws],
    queryFn: async () => MatchRulesResponse.parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/match-rules", { params: { path: { ws } } }))),
  });

const pct = (part: string, total: string) => (new Decimal(total).isZero() ? new Decimal(0) : new Decimal(part).div(total).mul(100));

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

export function CampaignMapping({ ws, from, to, canEditBudgets, onPeriod }: { ws: string; from: string | undefined; to: string | undefined; canEditBudgets: boolean; onPeriod: (p: { mapFrom?: string | undefined; mapTo?: string | undefined }) => void }): ReactElement {
  const { data: cov, isPending, error } = useQuery(coverageQuery(ws, from, to));
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <Card title={t("mapping.title")} tour="campaign-mapping" testId="campaign-mapping">
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">{t("mapping.help")}</p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t("mapping.from")}
            <Input type="date" size="sm" value={from ?? ""} onChange={(e) => onPeriod({ mapFrom: e.target.value || undefined })} data-testid="mapping-from" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t("mapping.to")}
            <Input type="date" size="sm" value={to ?? ""} onChange={(e) => onPeriod({ mapTo: e.target.value || undefined })} data-testid="mapping-to" />
          </label>
        </div>
        {error ? <p role="alert" className="text-sm text-destructive">{error.message}</p> : null}
        {isPending || !cov ? (
          <p className="text-sm text-muted-foreground">{t("shell.loading")}</p>
        ) : (
          <>
            <CoverageBar cov={cov} />
            {notice ? <p role="status" className="text-sm text-success-text" data-testid="mapping-notice">{notice}</p> : null}
            {cov.open.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="mapping-all-matched">{t("mapping.allMatched")}</p>
            ) : (
              <table className="tabular w-full text-sm" data-testid="mapping-open" data-tour="campaign-mapping-open">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3 font-medium">{t("mapping.col.campaign")}</th>
                    <th className="py-2 pr-3 font-medium">{t("mapping.col.status")}</th>
                    <th className="py-2 pr-3 text-right font-medium">{t("mapping.col.spend")}</th>
                    <th className="py-2 pr-3 font-medium">{t("mapping.col.dates")}</th>
                    <th className="py-2 pr-3 font-medium">{t("mapping.col.candidates")}</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {cov.open.map((o) => {
                    const key = `${o.campaign ?? ""}|${o.status}`;
                    return (
                      <OpenRow
                        key={key}
                        ws={ws}
                        o={o}
                        currency={cov.currency}
                        canEditBudgets={canEditBudgets}
                        expanded={open === key}
                        onToggle={() => setOpen(open === key ? null : key)}
                        onAssigned={(msg) => {
                          setOpen(null);
                          setNotice(msg);
                        }}
                      />
                    );
                  })}
                </tbody>
              </table>
            )}
          </>
        )}
        <RulesList ws={ws} canEditBudgets={canEditBudgets} />
      </div>
    </Card>
  );
}

function CoverageBar({ cov }: { cov: MatchCoverageResponse }): ReactElement {
  const { totals, currency } = cov;
  const segments = [
    { key: "matched", label: t("mapping.matched"), amount: totals.matched, cls: "bg-success" },
    { key: "unmatched", label: t("mapping.unmatched"), amount: totals.unmatched, cls: "bg-warning" },
    { key: "ambiguous", label: t("mapping.ambiguous"), amount: totals.ambiguous, cls: "bg-destructive" },
  ] as const;
  const fmt = (v: string) => moneyOrDash(v, currency);
  return (
    <div className="flex flex-col gap-1.5" data-testid="mapping-coverage" data-tour="campaign-mapping-coverage">
      <div
        className="flex h-3 w-full overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={t("mapping.bar", { matched: fmt(totals.matched), unmatched: fmt(totals.unmatched), ambiguous: fmt(totals.ambiguous), total: fmt(totals.total) })}
      >
        {segments.map((s) => (
          <div key={s.key} className={s.cls} style={{ width: `${pct(s.amount, totals.total).toFixed(2)}%` }} data-testid={`mapping-bar-${s.key}`} />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {segments.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5" data-testid={`mapping-share-${s.key}`}>
            <span className={cn("inline-block size-2 rounded-full", s.cls)} aria-hidden />
            {t("mapping.share", { label: s.label, amount: fmt(s.amount), pct: `${pct(s.amount, totals.total).toFixed(1)}%` })}
          </li>
        ))}
      </ul>
    </div>
  );
}

function OpenRow({ ws, o, currency, canEditBudgets, expanded, onToggle, onAssigned }: { ws: string; o: OpenCampaign; currency: string; canEditBudgets: boolean; expanded: boolean; onToggle: () => void; onAssigned: (msg: string) => void }): ReactElement {
  const name = o.label ?? o.campaign ?? t("mapping.noCampaign");
  const why = o.campaign === null ? t("mapping.noCampaignReason") : !canEditBudgets ? t("mapping.noEditReason") : null;
  return (
    <>
      <tr className="border-t border-border" data-testid="mapping-open-row">
        <td className="py-2 pr-3">
          <span className="font-medium">{name}</span>
          {o.label && o.campaign ? <span className="ml-2 text-xs text-muted-foreground">{o.campaign}</span> : null}
        </td>
        <td className="py-2 pr-3">
          <StatusChip status={o.status} tone={o.status === "ambiguous" ? "danger" : "warning"} label={t(o.status === "ambiguous" ? "mapping.ambiguous" : "mapping.unmatched")} icon={null} />
        </td>
        <td className="py-2 pr-3 text-right">{moneyOrDash(o.amount, currency)}</td>
        <td className="py-2 pr-3 text-xs text-muted-foreground">{t("mapping.ruleDates", { from: o.firstDate, to: o.lastDate })}</td>
        <td className="py-2 pr-3 text-xs">{o.candidates.map((c) => c.name).join(", ") || t("common.noValue")}</td>
        <td className="py-2 text-right">
          {why ? (
            <Button size="sm" variant="outline" disabled reason={why} data-testid="mapping-assign">
              {t("mapping.assign")}
            </Button>
          ) : (
            <Button size="sm" variant="outline" aria-expanded={expanded} onClick={onToggle} data-testid="mapping-assign">
              {t("mapping.assign")}
            </Button>
          )}
        </td>
      </tr>
      {expanded && o.campaign !== null ? (
        <tr>
          <td colSpan={6}>
            <AssignCampaign ws={ws} campaign={o.campaign} name={name} candidates={o.candidates} onDone={onAssigned} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function AssignCampaign({ ws, campaign, name, candidates, onDone }: { ws: string; campaign: string; name: string; candidates: OpenCampaign["candidates"]; onDone: (msg: string) => void }): ReactElement {
  const client = useQueryClient();
  const [q, setQ] = useState(name);
  const { data } = useQuery({ ...searchQuery(ws, q.trim(), { types: "envelope", limit: 6 }), enabled: q.trim().length > 1 });
  const hits = [...candidates.map((c) => ({ id: c.id, title: c.name, path: null as string | null })), ...(data?.groups.find((g) => g.type === "envelope")?.hits ?? []).filter((h) => !candidates.some((c) => c.id === h.id)).map((h) => ({ id: h.id, title: h.title, path: h.path ?? null }))];
  const assign = useMutation({
    mutationFn: async (envelopeId: string) =>
      MatchRuleWriteResponse.parse(await unwrap(api.POST("/api/v1/workspaces/{ws}/match-rules", { params: { path: { ws } }, body: { envelopeId, predicate: equalsPredicate(CAMPAIGN_DIMENSION, campaign) } as never }))),
    onSuccess: async (res) => {
      await Promise.all(["match-coverage", "match-rules", "unmatched"].map((k) => client.invalidateQueries({ queryKey: [k, ws] })));
      onDone(t("mapping.assigned", { campaign: name, budget: res.rule.envelopeName, n: res.rematch.spend + res.rematch.kpi + res.rematch.projection }));
    },
  });
  return (
    <div className="my-2 flex flex-col gap-1.5 rounded-lg bg-surface p-3" data-testid="mapping-picker">
      <Input type="search" size="sm" value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("sources.assignSearch")} placeholder={t("sources.assignSearch")} data-testid="mapping-search" />
      <ul className="flex flex-col gap-1">
        {hits.map((h) => (
          <li key={h.id}>
            <button type="button" className="w-full rounded-md px-2 py-1 text-left text-sm hover:bg-accent" aria-busy={assign.isPending} aria-label={t("mapping.assignTo", { campaign: name })} onClick={() => (assign.isPending ? undefined : assign.mutate(h.id))} data-testid="mapping-option">
              <span className="font-medium">{h.title}</span>
              {h.path ? <span className="ml-2 text-xs text-muted-foreground">{h.path}</span> : null}
            </button>
          </li>
        ))}
      </ul>
      {assign.error ? <p role="alert" className="text-xs text-destructive">{assign.error.message}</p> : null}
    </div>
  );
}

function RulesList({ ws, canEditBudgets }: { ws: string; canEditBudgets: boolean }): ReactElement {
  const client = useQueryClient();
  const { data, isPending } = useQuery(matchRulesQuery(ws));
  const remove = useMutation({
    mutationFn: async (id: string) => unwrap(api.DELETE("/api/v1/match-rules/{id}", { params: { path: { id }, header: { "X-Workspace-Id": ws } } })),
    onSuccess: () => Promise.all(["match-coverage", "match-rules", "unmatched"].map((k) => client.invalidateQueries({ queryKey: [k, ws] }))),
  });
  const rules = data?.rules ?? [];
  return (
    <div className="flex flex-col gap-1.5 border-t border-border pt-3" data-testid="mapping-rules" data-tour="campaign-mapping-rules">
      <h3 className="text-sm font-medium">{t("mapping.rules")}</h3>
      {isPending ? (
        <p className="text-sm text-muted-foreground">{t("shell.loading")}</p>
      ) : rules.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="mapping-rules-empty">{t("mapping.rulesNone")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {rules.map((r) => {
            const why = !canEditBudgets ? t("mapping.noEditReason") : remove.isPending ? t("mapping.deleting") : null;
            return (
              <li key={r.id} className="flex flex-wrap items-center gap-2 py-2 text-sm" data-testid="mapping-rule">
                <span>{t("mapping.ruleLine", { predicate: predicateText(r.predicate), budget: r.envelopeName })}</span>
                <span className="text-xs text-muted-foreground">{r.startDate || r.endDate ? t("mapping.ruleDates", { from: r.startDate ?? "…", to: r.endDate ?? "…" }) : t("mapping.ruleOpen")}</span>
                {why ? (
                  <Button size="sm" variant="ghost" className="ml-auto" disabled reason={why} aria-label={t("mapping.deleteRule")} data-testid="mapping-rule-delete">
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" className="ml-auto" aria-label={t("mapping.deleteRule")} onClick={() => remove.mutate(r.id)} data-testid="mapping-rule-delete">
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {remove.error ? <p role="alert" className="text-xs text-destructive">{remove.error.message}</p> : null}
    </div>
  );
}
