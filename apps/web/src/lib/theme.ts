import { useSyncExternalStore } from "react";

/**
 * UX-012: the colour theme. "system" follows the operating system. The choice is a per-browser
 * convenience (not app data), kept in localStorage; a private window or blocked storage falls back
 * to "system". index.html applies it before the first paint.
 */
export type ThemeChoice = "light" | "dark" | "system";
const KEY = "budget-os.theme";
const listeners = new Set<() => void>();

export function themeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

const media = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null);
export const resolvedTheme = (): "light" | "dark" => {
  const c = themeChoice();
  return c === "system" ? (media()?.matches ? "dark" : "light") : c;
};

function apply(): void {
  document.documentElement.dataset["theme"] = resolvedTheme();
}

export function setThemeChoice(choice: ThemeChoice): void {
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
  apply();
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  const m = media();
  const onChange = () => (apply(), l());
  m?.addEventListener("change", onChange);
  return () => {
    listeners.delete(l);
    m?.removeEventListener("change", onChange);
  };
}

export function useTheme(): { choice: ThemeChoice; resolved: "light" | "dark" } {
  const choice = useSyncExternalStore(subscribe, themeChoice, () => "system" as ThemeChoice);
  const resolved = useSyncExternalStore(subscribe, resolvedTheme, () => "light" as const);
  return { choice, resolved };
}
