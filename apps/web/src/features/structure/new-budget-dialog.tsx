import { Button, cn } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactElement, type ReactNode } from "react";
import { z } from "zod";
import { api, unwrap } from "../../lib/api.js";
import { periodsQuery, registryQuery } from "../../lib/queries.js";

/**
 * A top-level budget (product feedback 2026-09-28: a blank workspace needs a way to add its first
 * budgets; Add child needs a parent). Name, amount, dates (the current fiscal year by default) and
 * any granularity values; it opens as a draft, and the drawer then offers Send for approval.
 */

const MONEY = /^\d{1,13}(\.\d{1,2})?$/;
const field = "h-9 w-full rounded-md border border-input bg-card px-2.5 text-sm";

function thisYear(periods: Array<{ kind: string; start: string; end: string }>): { start: string; end: string } {
  const today = new Date().toISOString().slice(0, 10);
  const fy = periods.find((p) => p.kind === "year" && p.start <= today && p.end >= today);
  const y = today.slice(0, 4);
  return fy ? { start: fy.start, end: fy.end } : { start: `${y}-01-01`, end: `${y}-12-31` };
}

export function NewBudgetDialog({ ws, currency, onCreated, onCancel }: { ws: string; currency: string; onCreated: (envelopeId: string) => void; onCancel: () => void }): ReactElement {
  const client = useQueryClient();
  const { data: dimensions = [] } = useQuery(registryQuery(ws));
  const { data: periods = [] } = useQuery(periodsQuery(ws));
  const year = thisYear(periods);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [start, setStart] = useState<string | null>(null);
  const [end, setEnd] = useState<string | null>(null);
  const [dims, setDims] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startDate = start ?? year.start;
  const endDate = end ?? year.end;
  const cleanAmount = amount.replace(/,/g, "").trim();

  const why = !name.trim() ? t("newBudget.needName") : !MONEY.test(cleanAmount) ? t("newBudget.needAmount") : startDate > endDate ? t("newBudget.needDates") : null;

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = z
        .object({ id: z.string().uuid() })
        .passthrough()
        .parse(
          await unwrap(
            api.POST("/api/v1/workspaces/{ws}/envelopes", {
              params: { path: { ws } },
              body: { name: name.trim(), parentId: null, dimensionValues: dims, startDate, endDate, currency, amount: cleanAmount, rationale: t("newBudget.rationale") } as never,
            }),
          ),
        );
      await client.invalidateQueries({ queryKey: ["home", ws] });
      onCreated(r.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-inverse/30 p-6" role="dialog" aria-modal="true" aria-labelledby="new-budget-title" data-testid="new-budget-dialog">
      <div className="flex max-h-[85vh] w-full max-w-xl flex-col gap-4 overflow-y-auto rounded-xl border border-border bg-card p-6 shadow-lg">
        <div>
          <h2 id="new-budget-title" className="text-lg font-semibold tracking-[-0.015em]">{t("newBudget.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("newBudget.body")}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_11rem]">
          <Labeled label={t("newBudget.name")}>
            <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("newBudget.namePlaceholder")} autoFocus data-testid="new-budget-name" />
          </Labeled>
          <Labeled label={t("newBudget.amount", { currency })}>
            <input className={cn(field, "text-right tabular")} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" data-testid="new-budget-amount" />
          </Labeled>
          <Labeled label={t("newBudget.start")}>
            <input type="date" className={field} value={startDate} onChange={(e) => setStart(e.target.value)} data-testid="new-budget-start" />
          </Labeled>
          <Labeled label={t("newBudget.end")}>
            <input type="date" className={field} value={endDate} onChange={(e) => setEnd(e.target.value)} data-testid="new-budget-end" />
          </Labeled>
        </div>
        {dimensions.length ? (
          <div>
            <p className="mb-1 text-sm font-medium">{t("newBudget.dimensions")}</p>
            <p className="mb-2 text-xs text-muted-foreground">{t("newBudget.dimensionsHelp")}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {dimensions
                .filter((d) => d.isActive && d.values.length > 0)
                .map((d) => (
                  <label key={d.key} className="flex flex-col gap-1 text-xs text-muted-foreground">
                    {d.label}
                    <select className={field} value={dims[d.key] ?? ""} onChange={(e) => setDims((c) => (e.target.value ? { ...c, [d.key]: e.target.value } : Object.fromEntries(Object.entries(c).filter(([k]) => k !== d.key))))} data-testid="new-budget-dim" data-key={d.key}>
                      <option value="">{t("structure.dimNone")}</option>
                      {d.values
                        .filter((v) => v.isActive)
                        .map((v) => (
                          <option key={v.code} value={v.code}>
                            {v.label}
                          </option>
                        ))}
                    </select>
                  </label>
                ))}
            </div>
          </div>
        ) : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>{t("paste.cancel")}</Button>
          {why !== null || busy ? (
            <Button disabled reason={busy ? t("shell.loading") : (why ?? "")}>{t("newBudget.create")}</Button>
          ) : (
            <Button onClick={() => void create()} data-testid="new-budget-create">{t("newBudget.create")}</Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <label className="flex flex-col gap-1 text-sm font-medium">
      {label}
      {children}
    </label>
  );
}
