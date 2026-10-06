import { t } from "./i18n.js";

// Lazy load to avoid circular dependency issues in tests
let formatMoney: ((value: string, currency: string) => string) | undefined;
let formatMoneyCompact: ((value: string, currency: string) => string) | undefined;

function getFormatters() {
  if (!formatMoney || !formatMoneyCompact) {
    const gridModule = require("@budget/grid");
    formatMoney = gridModule.formatMoney;
    formatMoneyCompact = gridModule.formatMoneyCompact;
  }
  return { formatMoney: formatMoney!, formatMoneyCompact: formatMoneyCompact! };
}

/**
 * Format a money value, or render the no-value indicator (—) when null/undefined.
 * Used when a display fallback should not coerce missing values to zero.
 * @param value - The amount as a string, or null/undefined for no value
 * @param currency - The currency code (e.g., "USD")
 * @param compact - If true, use formatMoneyCompact instead of formatMoney
 */
export function moneyOrDash(value: string | null | undefined, currency: string, compact = false): string {
  if (value === null || value === undefined) return t("noValue");
  const { formatMoney: fm, formatMoneyCompact: fmc } = getFormatters();
  return compact ? fmc(value, currency) : fm(value, currency);
}
