/** CSV cell formatting (spec §6.2, audit S-7): prevent formula injection and proper RFC 4180 quoting. */

/**
 * Format a value for CSV output, preventing formula injection and applying RFC 4180 quoting.
 * - Returns empty string for null/undefined
 * - Prefixes dangerous prefixes (=, +, -, @, tab, carriage return) with a single quote
 * - Quotes cells containing double-quote, comma, newline, or carriage return (doubling inner quotes)
 *
 * Use for text cells only. For numeric cells (amounts), check the column kind before calling this.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";

  const s = String(value);

  // Prevent formula injection: prefix dangerous characters with a single quote
  const escaped = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;

  // RFC 4180 quoting: quote if the cell contains special characters
  return /[",\r\n]/.test(escaped) ? `"${escaped.replace(/"/g, '""')}"` : escaped;
}
