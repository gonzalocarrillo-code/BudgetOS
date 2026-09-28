import type { ReactElement } from "react";
import { cn } from "../cn.js";

/**
 * The BudgetOS logo (UX-005, docs/UX_AUDIT_AND_ADMIN_PLAN.md §2.1): a rounded square in the primary
 * colour with three bars of decreasing width, the allocation and pacing motif of the product's own
 * pace bars; beside it the wordmark "Budget" + "OS". The wordmark is set in the UI face (no font
 * file is bundled, AGENTS §4). `mono` draws in the current text colour; `inverse` in white.
 */
export type LogoTone = "color" | "mono" | "inverse";

export function LogoMark({ size = 24, tone = "color", className }: { size?: number; tone?: LogoTone; className?: string }): ReactElement {
  const bg = tone === "color" ? "var(--primary)" : tone === "inverse" ? "#ffffff" : "currentColor";
  const bar = tone === "inverse" ? "var(--primary)" : "#ffffff";
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={cn("shrink-0", className)} aria-hidden focusable="false" data-testid="logo-mark">
      <rect width="32" height="32" rx="8" fill={bg} />
      <rect x="7" y="8.5" width="18" height="3.5" rx="1.75" fill={bar} />
      <rect x="7" y="14.25" width="13" height="3.5" rx="1.75" fill={bar} />
      <rect x="7" y="20" width="8" height="3.5" rx="1.75" fill={bar} />
    </svg>
  );
}

export function Logo({ variant = "full", size = 24, tone = "color", className }: { variant?: "full" | "mark" | "wordmark"; size?: number; tone?: LogoTone; className?: string }): ReactElement {
  const text = tone === "inverse" ? "text-white" : tone === "mono" ? "text-current" : "text-foreground";
  const os = tone === "color" ? "text-primary" : "";
  return (
    <span role="img" aria-label="BudgetOS" className={cn("inline-flex items-center gap-2", className)} data-testid="logo">
      {variant !== "wordmark" ? <LogoMark size={size} tone={tone} /> : null}
      {variant !== "mark" ? (
        <span aria-hidden className={cn("whitespace-nowrap font-semibold leading-none tracking-[-0.03em]", text)} style={{ fontSize: Math.round(size * 0.72) }}>
          Budget<span className={os}>OS</span>
        </span>
      ) : null}
    </span>
  );
}
