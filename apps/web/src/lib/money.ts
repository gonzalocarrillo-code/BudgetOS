import { formatMoney, formatMoneyCompact } from "@budget/grid";
import { t } from "@budget/ui/i18n";

/**
 * Format a money value, or render the no-value indicator (—) when null/undefined.
 * Used when a display fallback should not coerce missing values to zero.
 * @param value - The amount as a string, or null/undefined for no value
 * @param currency - The currency code (e.g., "USD")
 * @param compact - If true, use formatMoneyCompact instead of formatMoney
 */
export function moneyOrDash(value: string | null | undefined, currency: string, compact = false): string {
  if (value === null || value === undefined) return t("common.noValue");
  return compact ? formatMoneyCompact(value, currency) : formatMoney(value, currency);
}
