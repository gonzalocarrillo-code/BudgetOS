import { Button, Input } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useMutation } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { useState, type ReactElement } from "react";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A start – end range with a pencil that turns it into two date inputs (ADR-060: dates are
 * editable everywhere). `save` is the record's own write; its error shows under the inputs.
 * `locked` explains why the range cannot change here (a closed period, a concluded experiment).
 */
export function DateRangeEditor({
  start,
  end,
  save,
  locked,
  testId,
  onSaved,
}: {
  start: string;
  end: string;
  save: (range: { startDate: string; endDate: string }) => Promise<unknown>;
  locked?: string | null | undefined;
  testId: string;
  onSaved?: (() => void) | undefined;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  const [from, setFrom] = useState(start);
  const [to, setTo] = useState(end);
  const write = useMutation({
    mutationFn: () => save({ startDate: from, endDate: to }),
    onSuccess: () => {
      setEditing(false);
      onSaved?.();
    },
  });
  if (!editing) {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap" data-testid={testId}>
        <span className="tabular">
          {start} – {end}
        </span>
        {locked ? null : (
          <button
            type="button"
            className="rounded-md p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={t("dates.edit")}
            title={t("dates.edit")}
            onClick={(e) => {
              e.stopPropagation();
              setFrom(start);
              setTo(end);
              write.reset();
              setEditing(true);
            }}
            data-testid={`${testId}-edit`}
          >
            <Pencil className="size-3.5" aria-hidden />
          </button>
        )}
      </span>
    );
  }
  const why = !DATE.test(from) || !DATE.test(to) || from > to ? t("dates.needDates") : from === start && to === end ? t("dates.same") : write.isPending ? t("shell.loading") : null;
  return (
    <span className="inline-flex flex-col gap-1" onClick={(e) => e.stopPropagation()} data-testid={`${testId}-form`}>
      <span className="inline-flex flex-wrap items-center gap-1">
        <Input type="date" className="h-8 w-36" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label={t("structure.startDate")} data-testid={`${testId}-start`} />
        <span aria-hidden>–</span>
        <Input type="date" className="h-8 w-36" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label={t("structure.endsOn")} data-testid={`${testId}-end`} />
        {why ? (
          <Button size="sm" disabled reason={why} data-testid={`${testId}-save`}>
            {t("dates.save")}
          </Button>
        ) : (
          <Button size="sm" onClick={() => write.mutate()} data-testid={`${testId}-save`}>
            {t("dates.save")}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          {t("threads.cancel")}
        </Button>
      </span>
      {write.isError ? (
        <span className="text-xs text-destructive" role="alert">
          {write.error.message}
        </span>
      ) : null}
    </span>
  );
}
