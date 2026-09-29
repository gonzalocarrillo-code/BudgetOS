import type { PeriodRow } from "@budget/domain";
import { Select } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { periodsQuery } from "../../lib/queries.js";

/**
 * A period (HO-011, spec §18.3 `<PeriodPicker/>`): the relative presets, then the workspace's own
 * years, quarters and custom partitions (Admin › Fiscal calendar) as `fiscal:<key>`, like Budgets'
 * picker, so a fiscal quarter means the same days on both screens.
 */
export function PeriodPicker({ ws, value, presets, onChange, label, testId }: { ws: string; value: string; presets: readonly string[]; onChange: (value: string) => void; label?: string; testId?: string }): ReactElement {
  const { data: periods = [] } = useQuery(periodsQuery(ws));
  const own = (periods as PeriodRow[]).filter((p) => p.kind !== "month");
  return (
    <label className="flex items-center gap-2 text-sm text-muted-foreground">
      {label ?? t("overview.period")}
      <Select className="text-foreground" wrapperClassName="max-w-64" size="sm" value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId}>
        {presets.map((p) => (
          <option key={p} value={p}>
            {t(`explorer.period.${p}` as MessageKey)}
          </option>
        ))}
        {own.length ? (
          <optgroup label={t("explorer.period.calendar")}>
            {own.map((p) => (
              <option key={p.id} value={`fiscal:${p.key}`}>
                {p.key} · {p.start} – {p.end}
              </option>
            ))}
          </optgroup>
        ) : null}
      </Select>
    </label>
  );
}
