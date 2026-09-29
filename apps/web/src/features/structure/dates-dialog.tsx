import { DateChangePreview } from "@budget/domain";
import { Button, Input, Modal } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Clock, X } from "lucide-react";
import { useState, type ReactElement } from "react";
import { api, unwrap } from "../../lib/api.js";
import { envelopeQuery, type EnvelopeDetail } from "../../lib/queries.js";
import { useSettled } from "./structure-dialog.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export interface DatesResult {
  applied: boolean;
  requestId: string | null;
}

/**
 * Change a budget's dates (ADR-060), from the drawer or the Budgets grid's Dates column. A live
 * preview lists every budget the new dates move — the budget, then the children they would trim —
 * and says whether the change waits for approval. Children move only when the box is ticked.
 */
export function DatesDialog({ ws, envelopeId, onDone, onClose }: { ws: string; envelopeId: string; onDone: (r: DatesResult) => void; onClose: () => void }): ReactElement {
  const { data: env } = useQuery(envelopeQuery(ws, envelopeId));
  return (
    <Modal onClose={onClose} labelledBy="dates-title" testId="dates-dialog">
      <div className="flex max-h-[88vh] w-full max-w-xl flex-col gap-4 overflow-y-auto rounded-xl border border-border bg-card p-6 shadow-lg">
        {env ? <DatesForm ws={ws} env={env} onDone={onDone} onClose={onClose} /> : <p className="text-sm text-muted-foreground">{t("shell.loading")}</p>}
      </div>
    </Modal>
  );
}

function DatesForm({ ws, env, onDone, onClose }: { ws: string; env: EnvelopeDetail; onDone: (r: DatesResult) => void; onClose: () => void }): ReactElement {
  const [startDate, setStart] = useState(env.startDate);
  const [endDate, setEnd] = useState(env.endDate);
  const [trim, setTrim] = useState(false);
  const [rationale, setRationale] = useState("");
  const valid = DATE.test(startDate) && DATE.test(endDate) && startDate <= endDate;
  const changed = startDate !== env.startDate || endDate !== env.endDate;
  const basedOnVersionId = env.draftVersionId ?? env.currentVersionId;
  const settled = useSettled(valid && changed ? { startDate, endDate, basedOnVersionId } : null);
  const checking = JSON.stringify(settled) !== JSON.stringify(valid && changed ? { startDate, endDate, basedOnVersionId } : null);
  const preview = useQuery({
    queryKey: ["dates-preview", ws, env.id, settled],
    queryFn: async () => DateChangePreview.parse(await unwrap(api.POST("/api/v1/envelopes/{id}/dates/preview", { params: { path: { id: env.id }, header: { "X-Workspace-Id": ws } }, body: settled as never }))),
    enabled: settled !== null,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const commit = useMutation({
    mutationFn: async (): Promise<DatesResult> => {
      const r = (await unwrap(api.POST("/api/v1/envelopes/{id}/dates", { params: { path: { id: env.id }, header: { "X-Workspace-Id": ws } }, body: { startDate, endDate, basedOnVersionId, trimChildren: trim, rationale: rationale.trim() } as never }))) as unknown as { applied: boolean; requestId: string | null };
      return { applied: r.applied, requestId: r.requestId };
    },
    onSuccess: onDone,
  });

  const p = settled !== null && !preview.isError ? preview.data : undefined;
  const why = env.ended
    ? t("dates.ended")
    : !valid
      ? t("dates.needDates")
      : !changed
        ? t("dates.same")
        : checking || preview.isFetching
          ? t("structure.checking")
          : preview.isError
            ? preview.error.message
            : !p
              ? t("structure.checking")
              : p.childrenOutside > 0 && !trim
                ? t("dates.trimNeeded", { count: p.childrenOutside })
                : commit.isPending
                  ? t("shell.loading")
                  : null;
  const label = p?.needsApproval ? t("structure.submit") : t("dates.apply");

  return (
    <>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 id="dates-title" className="text-lg font-semibold tracking-[-0.015em]">
            {t("dates.title")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("dates.help", { name: env.name, start: env.startDate, end: env.endDate })}</p>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label={t("drawer.close")}>
          <X className="size-4" aria-hidden />
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t("structure.startDate")}
          <Input type="date" className="w-full" value={startDate} max={endDate} onChange={(e) => setStart(e.target.value)} data-testid="dates-start" />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t("structure.endsOn")}
          <Input type="date" className="w-full" value={endDate} min={startDate} onChange={(e) => setEnd(e.target.value)} data-testid="dates-end" />
        </label>
      </div>

      {p ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3 text-sm" data-testid="dates-preview" data-needs-approval={p.needsApproval ? "true" : "false"}>
          <p className="flex items-center gap-2 font-medium">
            {p.needsApproval ? <Clock className="size-4 text-warning" aria-hidden /> : <CheckCircle2 className="size-4 text-success" aria-hidden />}
            {p.needsApproval ? t("dates.needsApproval") : t("dates.now")}
          </p>
          <ul className="flex flex-col gap-1">
            {p.lines.map((l, i) => (
              <li key={l.envelopeId} className="flex flex-wrap items-center gap-x-2 text-muted-foreground" data-testid="dates-line">
                <span className={i === 0 ? "font-medium text-foreground" : ""}>{l.name}</span>
                <span className="tabular">
                  {l.from.startDate} – {l.from.endDate}
                </span>
                <ArrowRight className="size-3.5" aria-hidden />
                <span className="tabular text-foreground">
                  {l.to.startDate} – {l.to.endDate}
                </span>
                {l.rephased ? <span className="rounded bg-secondary px-1.5 text-xs">{t("dates.rephased")}</span> : null}
              </li>
            ))}
          </ul>
          {p.childrenOutside > 0 ? (
            <label className="flex items-start gap-2 pt-1 text-foreground">
              <input type="checkbox" className="mt-0.5" checked={trim} onChange={(e) => setTrim(e.target.checked)} data-testid="dates-trim" />
              <span>{t("dates.trim", { count: p.childrenOutside })}</span>
            </label>
          ) : null}
        </div>
      ) : null}

      <label className="flex flex-col gap-1 text-sm font-medium">
        {t("dates.reason")}
        <Input className="w-full" value={rationale} onChange={(e) => setRationale(e.target.value)} data-testid="dates-reason" />
      </label>

      {commit.isError ? (
        <p className="text-sm text-destructive" role="alert">
          {commit.error.message}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t("threads.cancel")}
        </Button>
        {why ? (
          <Button disabled reason={why} data-testid="dates-commit">
            {label}
          </Button>
        ) : (
          <Button onClick={() => commit.mutate()} data-testid="dates-commit">
            {label}
          </Button>
        )}
      </div>
    </>
  );
}
