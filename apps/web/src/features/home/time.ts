import { t } from "@budget/ui/i18n";

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", then the date (HO-006). */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  const mins = Math.max(0, Math.round((now - then) / 60_000));
  if (mins < 1) return t("home.time.now");
  if (mins < 60) return t("home.time.minutes", { n: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t("home.time.hours", { n: hours });
  const days = Math.floor(hours / 24);
  if (days === 1) return t("home.time.yesterday");
  if (days < 7) return t("home.time.days", { n: days });
  return new Date(iso).toLocaleDateString("en", { day: "numeric", month: "short" });
}

/** A calendar date the way the desk shows it: "Sep 30" (English, like every string in Phase 1). */
export const dayMonth = (iso: string): string => {
  const dateOnly = iso.length === 10;
  return new Date(dateOnly ? `${iso}T00:00:00Z` : iso).toLocaleDateString("en", { day: "numeric", month: "short", ...(dateOnly ? { timeZone: "UTC" } : {}) });
};
