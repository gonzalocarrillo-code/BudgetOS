import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * UX-006 (docs/UX_AUDIT_AND_ADMIN_PLAN.md §2.2): text tokens meet WCAG 2.2 AA (4.5:1) on the
 * surfaces they sit on. Read from tokens.css itself, so a design-team file that replaces it is held
 * to the same bar.
 */
const css = readFileSync(join(import.meta.dirname, "tokens.css"), "utf8");
const token = (name: string): string => {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (!m?.[1]) throw new Error(`token --${name} not found`);
  return m[1];
};
const channel = (c: number) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

const PAIRS: Array<[string, string]> = [
  ["foreground", "card"],
  ["foreground", "surface"],
  ["muted-foreground", "card"],
  ["muted-foreground", "surface"],
  ["muted-foreground", "muted"],
  ["subtle-foreground", "card"],
  ["primary-foreground", "primary"],
  ["primary", "card"],
  ["primary", "surface"],
  ["secondary-foreground", "secondary"],
  ["inverse-foreground", "inverse"],
  ["card", "destructive"],
  ["success-text", "success-soft"],
  ["warning-text", "warning-soft"],
  ["danger-text", "danger-soft"],
  ["info-text", "info-soft"],
  ["neutral-text", "neutral-soft"],
];

describe("design tokens meet WCAG AA contrast", () => {
  for (const [fg, bg] of PAIRS) {
    it(`--${fg} on --${bg} is at least 4.5:1`, () => {
      expect(contrast(token(fg), token(bg))).toBeGreaterThanOrEqual(4.5);
    });
  }
});
