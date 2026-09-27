import { BulkPreview, FamilyPlan, type FamilySum } from "@budget/domain";
import { formatMoney, parseMoney } from "@budget/grid";
import { Button, cn } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { z } from "zod";
import { api, unwrap } from "../../lib/api.js";

/**
 * The family editor (product feedback 5, ADR-039): a parent budget and its children together. Each
 * child is a % of the parent (it follows when the parent changes, and so do its own % children) or
 * its own amount; the footer says when they do not add up. "Review changes" saves how the children
 * follow and hands the amounts to the bulk preview: drafts, then one approval.
 */

type Row = { envelopeId: string; mode: "percent" | "manual"; value: string };

export const familyQuery = (ws: string, id: string) => ({
  queryKey: ["family", ws, id],
  queryFn: async () => FamilyPlan.parse(await unwrap(api.GET("/api/v1/envelopes/{id}/family", { params: { path: { id }, header: { "X-Workspace-Id": ws } } }))),
});

/** "Children USD 900 of USD 1,000 · USD 100 unallocated" (or "over by", or "add up"). */
export function FamilySumLine({ sum, currency, testId }: { sum: FamilySum; currency: string; testId?: string }): ReactElement {
  const money = (v: string) => formatMoney(v, currency);
  const gap = sum.unallocated.replace(/^-/, "");
  return (
    <p className={cn("text-sm", sum.status === "over" ? "text-destructive" : sum.status === "under" ? "text-warning" : "text-success")} data-testid={testId} data-status={sum.status}>
      {t("family.sum", { children: money(sum.childrenTotal), parent: money(sum.parentAmount) })}
      {" · "}
      {sum.status === "balanced" ? t("family.balanced") : sum.status === "under" ? t("family.under", { amount: money(gap) }) : t("family.over", { amount: money(gap) })}
    </p>
  );
}

const pctOf = (amount: string | null, parent: string | null) => {
  if (amount === null || parent === null || Number(parent) === 0) return "";
  // Four decimals: a share keeps the child within cents of where it is (the API takes six).
  return ((Number(amount) / Number(parent)) * 100).toFixed(4).replace(/\.?0+$/, "");
};

export function FamilyEditor({ ws, id, onReview, onClose }: { ws: string; id: string; onReview: (preview: BulkPreview) => void; onClose: () => void }): ReactElement {
  const { data: family, error } = useQuery(familyQuery(ws, id));
  const [parentAmount, setParentAmount] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [rationale, setRationale] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Start from the family as it is: % children keep their share, the others their amount.
  useEffect(() => {
    if (!family) return;
    setParentAmount(family.parent.before ?? "0.00");
    setRows(family.members.map((m) => (m.mode === "percent" && m.pct !== null ? { envelopeId: m.envelopeId, mode: "percent", value: m.pct } : { envelopeId: m.envelopeId, mode: "manual", value: m.before ?? "0.00" })));
  }, [family]);

  const input = useMemo(() => {
    const amount = parseMoney(parentAmount);
    if (amount === null) return null;
    const children = rows.map((r) => (r.mode === "percent" ? { envelopeId: r.envelopeId, mode: "percent" as const, pct: r.value.trim() } : { envelopeId: r.envelopeId, mode: "manual" as const, amount: parseMoney(r.value) ?? "" }));
    if (children.some((c) => ("pct" in c ? !/^\d{1,3}(\.\d{1,6})?$/.test(c.pct) || Number(c.pct) > 100 : c.amount === ""))) return null;
    return { parentAmount: amount, children, rationale: rationale.trim().length >= 3 ? rationale.trim() : t("family.rationaleDefault") };
  }, [parentAmount, rows, rationale]);

  const { data: plan } = useQuery({
    queryKey: ["family-preview", ws, id, input],
    queryFn: async () => FamilyPlan.parse(await unwrap(api.POST("/api/v1/envelopes/{id}/family/preview", { params: { path: { id }, header: { "X-Workspace-Id": ws } }, body: input as never }))),
    enabled: input !== null && family !== undefined,
    placeholderData: keepPreviousData,
  });

  const byId = new Map((plan ?? family)?.members.map((m) => [m.envelopeId, m]));
  const deeper = (plan?.members ?? []).filter((m) => m.level > 1 && m.changed).length;
  const sum = (plan ?? family)?.sums[0] ?? null;
  const currency = family?.parent.currency ?? "USD";
  const changedCount = plan ? [plan.parent, ...plan.members].filter((m) => m.changed).length : 0;

  const setRow = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const toggle = (i: number, mode: Row["mode"]) => {
    const r = rows[i];
    const m = r ? byId.get(r.envelopeId) : undefined;
    if (!r || r.mode === mode) return;
    // To %: the child's share of the family as it is now (its amount over the parent's), so it
    // follows a new parent amount from there. To an amount: what the plan gives it now.
    setRow(i, { mode, value: mode === "percent" ? pctOf(m?.before ?? null, family?.parent.before ?? null) || "0" : (m?.after ?? m?.before ?? "0.00") });
  };

  const review = async () => {
    if (!input) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = z.object({ preview: z.unknown() }).parse(await unwrap(api.POST("/api/v1/envelopes/{id}/family", { params: { path: { id }, header: { "X-Workspace-Id": ws } }, body: input as never })));
      if (res.preview === null) onClose();
      else onReview(BulkPreview.parse(res.preview));
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  const field = "h-8 rounded-md border border-input bg-card px-2 text-right text-sm tabular-nums";
  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-inverse/30 p-6" role="dialog" aria-modal="true" aria-labelledby="family-title" data-testid="family-editor">
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col gap-4 rounded-xl border border-border bg-card p-6 shadow-lg">
        <div>
          <h2 id="family-title" className="text-lg font-semibold tracking-[-0.015em]">
            {t("family.title", { name: family?.parent.name ?? "…" })}
          </h2>
          <p className="text-sm text-muted-foreground">{t("family.body")}</p>
        </div>
        {error ? <p role="alert" className="text-sm text-destructive">{error.message}</p> : null}
        <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3 py-2.5">
          <span className="text-sm font-medium">{t("family.parentAmount", { currency })}</span>
          <input className={cn(field, "w-44")} value={parentAmount} onChange={(e) => setParentAmount(e.target.value)} inputMode="decimal" data-testid="family-parent" />
        </label>
        <div className="overflow-y-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surface text-left text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t("family.col.child")}</th>
                <th className="px-3 py-2 font-medium">{t("family.col.follows")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("family.col.value")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("family.col.amount")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const m = byId.get(r.envelopeId);
                return (
                  <tr key={r.envelopeId} className="border-t border-border" data-testid="family-row" data-mode={r.mode}>
                    <td className="max-w-64 truncate px-3 py-2" title={m?.name}>
                      {m?.name}
                      {m && m.childCount > 0 ? <span className="ml-1.5 text-xs text-muted-foreground">{t("family.subBudgets", { count: m.childCount })}</span> : null}
                    </td>
                    <td className="px-3 py-2">
                      <div role="radiogroup" aria-label={t("family.col.follows")} className="inline-flex rounded-md border border-border p-0.5">
                        {(["percent", "manual"] as const).map((mode) =>
                          mode === "percent" && m && !m.sameCurrency ? (
                            <Button key={mode} size="sm" variant="ghost" className="h-6 px-2" disabled reason={t("family.otherCurrency", { currency: m.currency })}>
                              %
                            </Button>
                          ) : (
                            <button key={mode} type="button" role="radio" aria-checked={r.mode === mode} onClick={() => toggle(i, mode)} className={cn("h-6 rounded px-2 text-xs", r.mode === mode ? "bg-primary text-primary-foreground" : "text-foreground/80 hover:bg-accent")} data-testid={`family-mode-${mode}`}>
                              {mode === "percent" ? "%" : t("family.mode.amount")}
                            </button>
                          ),
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input className={cn(field, "w-32")} value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} inputMode="decimal" aria-label={r.mode === "percent" ? t("family.col.pct") : t("family.col.amount")} data-testid="family-value" />
                      {r.mode === "percent" ? <span className="ml-1 text-muted-foreground">%</span> : null}
                    </td>
                    <td className={cn("px-3 py-2 text-right tabular-nums", m?.changed && "font-medium")} data-testid="family-after">
                      {m?.after ? formatMoney(m.after, m.currency) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex flex-col gap-1">
          {sum ? <FamilySumLine sum={sum} currency={currency} testId="family-sum" /> : null}
          {deeper ? <p className="text-xs text-muted-foreground" data-testid="family-deeper">{t("family.deeper", { count: deeper })}</p> : null}
        </div>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t("family.rationale")}</span>
          <input className="h-8 rounded-md border border-input bg-card px-2 text-sm" value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder={t("family.rationaleDefault")} data-testid="family-rationale" />
        </label>
        {saveError ? <p role="alert" className="text-sm text-destructive">{saveError}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t("paste.cancel")}
          </Button>
          {input === null || saving ? (
            <Button disabled reason={saving ? t("shell.loading") : t("family.invalid")}>
              {t("family.review")}
            </Button>
          ) : (
            <Button onClick={() => void review()} data-testid="family-review">
              {changedCount ? t("family.reviewCount", { count: changedCount }) : t("family.review")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
