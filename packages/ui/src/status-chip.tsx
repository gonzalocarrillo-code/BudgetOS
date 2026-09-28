import { AlertOctagon, AlertTriangle, Archive, Ban, Check, CheckCircle2, Circle, Clock, FlaskConical, Info, Loader2, Lock, LockOpen, PencilLine, RotateCcw, XCircle, type LucideIcon } from "lucide-react";
import type { HTMLAttributes, ReactElement, ReactNode } from "react";
import { cn } from "./cn.js";
import { hasMessage, t } from "./i18n.js";

/**
 * One status vocabulary (UX-006, docs/UX_AUDIT_AND_ADMIN_PLAN.md P1-4): every status reads as a
 * word with an icon on a tinted chip, never colour alone and never a raw lowercase code. Screens
 * pass the status; a screen with its own wording passes `label`.
 */
export type ChipTone = "success" | "warning" | "danger" | "info" | "neutral";

const TONE: Record<ChipTone, string> = {
  success: "bg-success-soft text-success-text",
  warning: "bg-warning-soft text-warning-text",
  danger: "bg-danger-soft text-danger-text",
  info: "bg-info-soft text-info-text",
  neutral: "bg-neutral-soft text-neutral-text",
};

const VOCABULARY: Record<string, { tone: ChipTone; icon: LucideIcon }> = {
  DRAFT: { tone: "neutral", icon: PencilLine },
  PENDING: { tone: "warning", icon: Clock },
  SUBMITTED: { tone: "warning", icon: Clock },
  CHANGES_REQUESTED: { tone: "warning", icon: RotateCcw },
  ESCALATED: { tone: "danger", icon: AlertTriangle },
  APPROVED: { tone: "success", icon: Check },
  ACTIVE: { tone: "success", icon: Check },
  REJECTED: { tone: "danger", icon: XCircle },
  WITHDRAWN: { tone: "neutral", icon: Ban },
  SUPERSEDED: { tone: "neutral", icon: Archive },
  LOCKED: { tone: "info", icon: Lock },
  ARCHIVED: { tone: "neutral", icon: Archive },
  OPEN: { tone: "warning", icon: Circle },
  ACKNOWLEDGED: { tone: "info", icon: Check },
  SNOOZED: { tone: "neutral", icon: Clock },
  RESOLVED: { tone: "success", icon: CheckCircle2 },
  PLANNED: { tone: "neutral", icon: FlaskConical },
  RUNNING: { tone: "info", icon: Loader2 },
  EVALUATING: { tone: "warning", icon: Clock },
  CONCLUDED: { tone: "success", icon: CheckCircle2 },
  ABANDONED: { tone: "neutral", icon: Ban },
  CLOSED: { tone: "info", icon: Lock },
  RESTATED: { tone: "neutral", icon: LockOpen },
  OK: { tone: "success", icon: CheckCircle2 },
  FAILED: { tone: "danger", icon: XCircle },
  QUEUED: { tone: "neutral", icon: Clock },
  CRITICAL: { tone: "danger", icon: AlertOctagon },
  WARNING: { tone: "warning", icon: AlertTriangle },
  INFO: { tone: "info", icon: Info },
  DATA: { tone: "neutral", icon: Info },
};

const key = (status: string) => status.trim().toUpperCase().replace(/[\s-]+/g, "_");

/** The tone a status reads in (for bars and dots next to text). */
export const statusTone = (status: string): ChipTone => VOCABULARY[key(status)]?.tone ?? "neutral";

/** The word a status reads as ("Waiting for approval", not "pending"). */
export function statusLabel(status: string): string {
  const k = `status.word.${key(status)}`;
  return hasMessage(k) ? t(k) : status.charAt(0).toUpperCase() + status.slice(1).toLowerCase().replace(/_/g, " ");
}

export function Chip({ tone = "neutral", icon: Icon, children, className, ...rest }: { tone?: ChipTone; icon?: LucideIcon | null; children: ReactNode } & HTMLAttributes<HTMLSpanElement>): ReactElement {
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 text-xs font-medium", TONE[tone], className)} {...rest}>
      {Icon ? <Icon className="size-3.5 shrink-0" aria-hidden /> : null}
      {children}
    </span>
  );
}

export function StatusChip({ status, label, tone, icon, ...rest }: { status: string; label?: string; tone?: ChipTone; icon?: LucideIcon | null } & Omit<HTMLAttributes<HTMLSpanElement>, "children">): ReactElement {
  const v = VOCABULARY[key(status)];
  return (
    <Chip tone={tone ?? v?.tone ?? "neutral"} icon={icon === undefined ? (v?.icon ?? null) : icon} data-status={status} {...rest}>
      {label ?? statusLabel(status)}
    </Chip>
  );
}
