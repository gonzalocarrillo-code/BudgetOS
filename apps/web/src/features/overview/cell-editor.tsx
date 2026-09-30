import { BulkPreview, LIVE_LEAVES, type FilterGroupT } from "@budget/domain";
import { formatMoney, parseMoney } from "@budget/grid";
import { Button, Input } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useState, type ReactElement } from "react";
import { z } from "zod";
import { api, unwrap } from "../../lib/api.js";
import { PasteDialog } from "../explorer/paste-dialog.js";
import { SendForApproval } from "../explorer/send-for-approval.js";

/**
 * Edit the budgets behind one heatmap cell without leaving the Overview (product feedback: "edit
 * everything in overview"). The cell's leaf budgets with their spend; each takes a new amount
 * (a draft, then Send for approval, as in Budgets), or all of them change by a percentage through
 * the bulk preview (nothing is written until Commit; the approval policy applies).
 */

export interface CellRef {
  row: { key: string; code: string; label: string };
  col: { key: string; code: string; label: string };
}

const Row = z.object({ envelopeId: z.string().uuid().nullable(), versionId: z.string().uuid().nullable().optional(), path: z.array(z.string()), measures: z.record(z.string(), z.string().nullable()) }).passthrough();
const Rows = z.object({ rows: z.array(Row), totals: z.record(z.string(), z.string().nullable()) }).passthrough();

const pct = (v: string | null | undefined) => (v === null || v === undefined ? "—" : `${(Number(v) * 100).toFixed(0)}%`);

export function cellFilter(cell: CellRef): FilterGroupT {
  return {
    logic: "and",
    children: [
      { field: { kind: "dimension", key: cell.row.key }, op: "eq", value: cell.row.code },
      { field: { kind: "dimension", key: cell.col.key }, op: "eq", value: cell.col.code },
    ],
  };
}

export function CellEditor({ ws, cell, period, currency, onClose }: { ws: string; cell: CellRef; period: Record<string, unknown>; currency: string; onClose: () => void }): ReactElement {
  const client = useQueryClient();
  const filter = cellFilter(cell);
  const key = ["overview-cell", ws, cell.row.key, cell.row.code, cell.col.key, cell.col.code, JSON.stringify(period)];
  const { data, error, isPending } = useQuery({
    queryKey: key,
    queryFn: async () =>
      Rows.parse(
        await unwrap(
          api.POST("/api/v1/workspaces/{ws}/query", {
            params: { path: { ws } },
            body: { workspaceId: ws, filter: { logic: "and", children: [...LIVE_LEAVES, filter] }, period, measures: ["budget", "actual", "spend_to_date_pct"], sort: [{ key: "budget", dir: "desc" }], limit: 200 } as never,
          }),
        ),
      ),
  });
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, true>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [change, setChange] = useState("");
  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [committed, setCommitted] = useState<number | null>(null);
  const money = (v: string | null | undefined) => (v === null || v === undefined ? "—" : formatMoney(v, currency));

  const refresh = async () => {
    await client.invalidateQueries({ queryKey: key });
    await client.invalidateQueries({ queryKey: ["overview", ws] });
  };

  const save = async (envelopeId: string, versionId: string | null) => {
    const amount = parseMoney(amounts[envelopeId] ?? "");
    if (amount === null) return setRowError((e) => ({ ...e, [envelopeId]: t("overview.edit.invalid") }));
    const res = await api.PATCH("/api/v1/envelopes/{id}/draft", { params: { path: { id: envelopeId }, header: { "X-Workspace-Id": ws } }, body: { amount, basedOnVersionId: versionId } as never });
    if (!res.response.ok) {
      const e = (res.error ?? {}) as { message?: string };
      return setRowError((x) => ({ ...x, [envelopeId]: res.response.status === 409 ? t("overview.edit.conflict") : (e.message ?? String(res.response.status)) }));
    }
    setRowError((x) => ({ ...x, [envelopeId]: "" }));
    setSaved((s) => ({ ...s, [envelopeId]: true }));
    await client.invalidateQueries({ queryKey: ["envelope", ws, envelopeId] });
    await refresh();
  };

  const previewChange = async () => {
    const n = Number(change);
    if (!Number.isFinite(n) || change.trim() === "" || n <= -100) return setNotice(t("overview.edit.pctInvalid"));
    setNotice(null);
    try {
      const p = BulkPreview.parse(
        await unwrap(
          api.POST("/api/v1/envelopes/bulk", {
            params: { header: { "X-Workspace-Id": ws } },
            body: { workspaceId: ws, selection: { filter: { logic: "and", children: [...LIVE_LEAVES, filter] } }, operation: { op: "pct", pct: n }, rationale: t("overview.edit.rationale", { pct: n, row: cell.row.label, col: cell.col.label }) } as never,
          }),
        ),
      );
      setPreview(p);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  };

  const leaves = (data?.rows ?? []).filter((r) => r.envelopeId !== null);
  return (
    <aside className="fixed bottom-0 right-0 top-16 z-20 flex w-[30rem] max-w-full flex-col gap-4 overflow-y-auto border-l border-border bg-card p-5 shadow-lg" aria-label={t("overview.edit.title", { row: cell.row.label, col: cell.col.label })} data-testid="cell-editor">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold tracking-[-0.015em]">{t("overview.edit.title", { row: cell.row.label, col: cell.col.label })}</h2>
          {data ? <p className="text-sm text-muted-foreground" data-testid="cell-editor-summary">{t("overview.edit.summary", { count: leaves.length, budget: money(data.totals["budget"]), spent: pct(data.totals["spend_to_date_pct"]) })}</p> : null}
        </div>
        <button type="button" className="rounded-md p-1 text-muted-foreground hover:bg-accent" onClick={onClose} aria-label={t("overview.edit.close")} data-testid="cell-editor-close">
          <X className="size-4" aria-hidden />
        </button>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
        <label className="text-sm font-medium" htmlFor="cell-change">{t("overview.edit.changeAll", { count: leaves.length })}</label>
        <div className="flex items-center gap-2">
          <Input id="cell-change" inputMode="decimal" className="w-24 text-right tabular" size="sm" placeholder="+10" value={change} onChange={(e) => setChange(e.target.value)} data-testid="cell-change" />
          <span className="text-sm text-muted-foreground">%</span>
          {leaves.length === 0 ? (
            <Button size="sm" disabled reason={t("overview.edit.noLeaves")}>{t("overview.edit.preview")}</Button>
          ) : (
            <Button size="sm" onClick={() => void previewChange()} data-testid="cell-change-preview">{t("overview.edit.preview")}</Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t("overview.edit.changeHelp")}</p>
        {notice ? <p className="text-sm text-destructive" role="alert">{notice}</p> : null}
      </div>

      {error ? <p role="alert" className="text-sm text-destructive">{error.message}</p> : null}
      {isPending ? <p className="text-sm text-muted-foreground">{t("shell.loading")}</p> : null}
      {data && leaves.length === 0 ? <p className="text-sm text-muted-foreground">{t("overview.edit.noLeaves")}</p> : null}
      <ul className="flex flex-col divide-y divide-border" data-testid="cell-editor-rows">
        {leaves.map((r) => {
          const id = r.envelopeId as string;
          return (
            <li key={id} className="flex flex-col gap-2 py-3" data-testid="cell-editor-row">
              <div className="flex items-baseline gap-2">
                <Link to="/w/$ws/budgets" params={{ ws }} search={{ select: id } as never} className="min-w-0 flex-1 truncate text-sm font-medium hover:text-primary">{r.path.at(-1)}</Link>
                <span className="tabular text-xs text-muted-foreground">{t("overview.edit.rowLine", { budget: money(r.measures["budget"]), spent: pct(r.measures["spend_to_date_pct"]) })}</span>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  inputMode="decimal"
                  aria-label={t("overview.edit.newAmount", { name: r.path.at(-1) ?? "" })}
                  className="w-36 text-right tabular" size="sm"
                  placeholder={r.measures["budget"] ?? ""}
                  value={amounts[id] ?? ""}
                  onChange={(e) => setAmounts((a) => ({ ...a, [id]: e.target.value }))}
                  data-testid="cell-editor-amount"
                />
                {(amounts[id] ?? "").trim() === "" ? (
                  <Button size="sm" variant="outline" disabled reason={t("overview.edit.typeAmount")}>{t("overview.edit.saveDraft")}</Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => void save(id, r.versionId ?? null)} data-testid="cell-editor-save">{t("overview.edit.saveDraft")}</Button>
                )}
              </div>
              {rowError[id] ? <p className="text-sm text-destructive" role="alert">{rowError[id]}</p> : null}
              {saved[id] ? <SendForApproval ws={ws} envelopeId={id} compact /> : null}
            </li>
          );
        })}
      </ul>

      <Link
        to="/w/$ws/budgets"
        params={{ ws }}
        search={{ filter } as never}
        className="text-sm text-primary hover:underline"
        data-testid="cell-editor-open-budgets"
      >
        {t("overview.edit.openBudgets")}
      </Link>

      {preview ? (
        <PasteDialog
          ws={ws}
          preview={preview}
          title={t("overview.edit.previewTitle", { pct: change })}
          body={t("overview.edit.previewBody")}
          onCancel={() => setPreview(null)}
          onDone={(n) => {
            setPreview(null);
            setChange("");
            setNotice(null);
            void refresh();
            setSaved({});
            setAmounts({});
            setCommitted(n);
          }}
        />
      ) : null}
      {committed !== null ? <p className="text-sm text-success" role="status" data-testid="cell-change-done">{t("overview.edit.committed", { count: committed })}</p> : null}
    </aside>
  );
}
