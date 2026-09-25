import type { BulkPreview } from "@budget/domain";
import { formatMoney } from "@budget/grid";
import { Button } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useState, type ReactElement } from "react";
import { api, unwrap } from "../../lib/api.js";

/**
 * The bulk preview a paste opens (spec §18.2, T-013): the rows before and after, totals, cap
 * violations and the approval policy that will apply. Nothing is written until Commit.
 */
export function PasteDialog({ ws, preview, onDone, onCancel }: { ws: string; preview: BulkPreview; onDone: (committed: number) => void; onCancel: () => void }): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commit = async () => {
    setBusy(true);
    try {
      await unwrap(api.POST("/api/v1/envelopes/bulk/{previewId}/commit", { params: { path: { previewId: preview.previewId }, header: { "X-Workspace-Id": ws } } }));
      onDone(preview.rows.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  const money = (v: string | null) => (v === null ? "—" : formatMoney(v, "USD"));
  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-inverse/30 p-6" role="dialog" aria-modal="true" aria-labelledby="paste-title" data-testid="paste-dialog">
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col gap-4 rounded-xl border border-border bg-card p-6 shadow-lg">
        <div>
          <h2 id="paste-title" className="text-lg font-semibold tracking-[-0.015em]">
            {t("paste.title")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("paste.body")}</p>
        </div>
        <div className="overflow-y-auto rounded-lg border border-border">
          <table className="tabular w-full text-sm">
            <thead className="bg-surface text-left text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t("paste.col.envelope")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("paste.col.before")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("paste.col.after")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("paste.col.delta")}</th>
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((r) => (
                <tr key={r.envelopeId} className="border-t border-border" data-testid="paste-row">
                  <td className="px-3 py-2">{r.path.at(-1)}</td>
                  <td className="px-3 py-2 text-right">{money(r.before)}</td>
                  <td className="px-3 py-2 text-right font-medium">{money(r.after)}</td>
                  <td className="px-3 py-2 text-right">{money(r.delta)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span data-testid="paste-totals">{t("paste.totals", { before: money(preview.totalsBefore), after: money(preview.totalsAfter) })}</span>
          {preview.policyPreview ? <span>{t("paste.policy", { name: preview.policyPreview.name })}</span> : null}
          {preview.capViolations.length ? <span className="text-destructive">{t("paste.caps", { count: preview.capViolations.length })}</span> : null}
          {preview.skipped.length ? <span>{t("paste.skipped", { count: preview.skipped.length })}</span> : null}
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>
            {t("paste.cancel")}
          </Button>
          {busy ? (
            <Button disabled reason={t("shell.loading")}>
              {t("paste.commit", { count: preview.rows.length })}
            </Button>
          ) : (
            <Button onClick={() => void commit()} data-testid="paste-commit">
              {t("paste.commit", { count: preview.rows.length })}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
